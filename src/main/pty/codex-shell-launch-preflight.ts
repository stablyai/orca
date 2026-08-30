import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

const DEV_LAUNCHER_DIR = ['cli', 'bin']
const DEV_COMMAND_NAME = 'orca-dev'
const CODEX_VERSION_PROBE_ATTEMPTS = 40
const CODEX_VERSION_PROBE_INTERVAL_SECONDS = '0.05'

export type CodexShellLaunchPreflightCommandOptions = {
  hooksEnabled: boolean
  isPackaged: boolean
  isWsl?: boolean
  managedHomePath: string | null
  /** Where the dev launcher is written; `join(userDataPath, 'cli', 'bin')` is also what managed dev PTYs prepend to PATH. */
  userDataPath: string
  /** Packaged app resources root; the bundled launcher lives under it. */
  resourcesPath?: string | null
  /** Test seam. */
  platform?: NodeJS.Platform
}

/** Absolute path of the Orca CLI the preflight must execute, or null to skip it.
 *
 *  Why absolute: the value rides in ORCA_CODEX_LAUNCH_PREFLIGHT and is invoked
 *  from the codex() wrapper, which shell-ready emits *after* the user's profile
 *  scripts run. Those scripts routinely rewrite PATH, so an unqualified name
 *  would be resolved against a PATH Orca neither controls nor can predict —
 *  handing Orca's managed Codex environment to an unidentified program. When no
 *  path verifies, skipping the preflight is the predictable degradation. */
export function resolveCodexShellLaunchPreflightCommand(
  options: CodexShellLaunchPreflightCommandOptions
): string | null {
  if (!options.hooksEnabled || !options.managedHomePath) {
    return null
  }
  const platform = options.platform ?? process.platform
  const candidate = options.isPackaged
    ? options.resourcesPath
      ? getBundledLauncherPath(platform, options.resourcesPath)
      : null
    : join(
        options.userDataPath,
        ...DEV_LAUNCHER_DIR,
        platform === 'win32' ? `${DEV_COMMAND_NAME}.cmd` : DEV_COMMAND_NAME
      )
  if (!candidate || !isExecutableFileOnDisk(candidate, platform)) {
    return null
  }
  if (!options.isWsl) {
    return candidate
  }
  // Why: WSLENV /p translates the verified Windows launcher with the distro's configured automount root.
  return platform === 'win32' && options.isPackaged ? candidate : null
}

function isExecutableFileOnDisk(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    // Why: Windows has no exec bit, so a readable launcher file is the strongest signal available.
    accessSync(path, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function getPosixCodexShellLaunchPreflight(): string {
  return `# Why: a typed alias expands inside the shell, after pane launch prep.
# Why unalias inside the substitution: an alias named codex makes command -v
# report the alias text, and the subshell leaves the user's own alias intact.
# Why || : twice — zsh alone aborts inside the substitution, but every shell's
# assignment adopts its exit status, so an absent codex trips set -e in bash too.
__orca_codex_binary="$(unalias codex 2>/dev/null || :; command -v codex 2>/dev/null || :)"
__orca_codex_alias="$(alias codex 2>/dev/null || :)"
__orca_codex_hooks_enabled="\${__orca_codex_hooks_enabled:-}"
__orca_has_feature codex-hooks 2>/dev/null && __orca_codex_hooks_enabled=1
__orca_codex_hooks_override() {
  local value
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --) return 1 ;;
      --enable|--disable) [[ "\${2:-}" == hooks || "\${2:-}" == codex_hooks ]] && return 0 ;;
      --enable=hooks|--disable=hooks|--enable=codex_hooks|--disable=codex_hooks) return 0 ;;
      -c|--config) value="\${2:-}" ;;
      -c=*|--config=*) value="\${1#*=}" ;;
      -c?*) value="\${1#-c}" ;;
      *) value="" ;;
    esac
    case "$value" in
      features.hooks|features.hooks=*|features.hooks[[:space:]]*=*|features.codex_hooks|features.codex_hooks=*|features.codex_hooks[[:space:]]*=*) return 0 ;;
    esac
    shift
  done
  return 1
}
__orca_codex_hooks_feature() {
  local __orca_codex_version __orca_codex_major __orca_codex_minor __orca_codex_patch __orca_codex_probe_file __orca_codex_probe_pid __orca_codex_remaining __orca_codex_probe_status
  __orca_codex_probe_file="$(mktemp "\${TMPDIR:-/tmp}/orca-codex-version.XXXXXX" 2>/dev/null)" || return 0
  command codex --version >"$__orca_codex_probe_file" 2>/dev/null &
  __orca_codex_probe_pid=$!
  __orca_codex_remaining=${CODEX_VERSION_PROBE_ATTEMPTS}
  while kill -0 "$__orca_codex_probe_pid" 2>/dev/null && [[ $__orca_codex_remaining -gt 0 ]]; do
    sleep ${CODEX_VERSION_PROBE_INTERVAL_SECONDS} 2>/dev/null || break
    __orca_codex_remaining=$(( __orca_codex_remaining - 1 ))
  done
  if kill -0 "$__orca_codex_probe_pid" 2>/dev/null; then
    kill -KILL "$__orca_codex_probe_pid" 2>/dev/null || :
    wait "$__orca_codex_probe_pid" 2>/dev/null || :
    rm -f "$__orca_codex_probe_file"
    return 0
  fi
  if wait "$__orca_codex_probe_pid" 2>/dev/null; then __orca_codex_probe_status=0; else __orca_codex_probe_status=$?; fi
  __orca_codex_version="$(<"$__orca_codex_probe_file")"
  rm -f "$__orca_codex_probe_file"
  [[ "$__orca_codex_probe_status" == 0 ]] || return 0
  __orca_codex_version="\${__orca_codex_version##* }"
  __orca_codex_major="\${__orca_codex_version%%.*}"
  __orca_codex_minor="\${__orca_codex_version#*.}"; __orca_codex_minor="\${__orca_codex_minor%%.*}"
  __orca_codex_patch="\${__orca_codex_version#*.*.}"; __orca_codex_patch="\${__orca_codex_patch%%[-+]*}"
  [[ -n "$__orca_codex_major" && -n "$__orca_codex_minor" && -n "$__orca_codex_patch" ]] || return 0
  [[ "$__orca_codex_major" != *[^0-9]* && "$__orca_codex_minor" != *[^0-9]* && "$__orca_codex_patch" != *[^0-9]* ]] || return 0
  if (( __orca_codex_major >= 1 )); then
    printf hooks
  elif (( __orca_codex_minor >= 129 )); then
    printf hooks
  elif (( __orca_codex_minor >= 114 )); then
    printf codex_hooks
  fi
}
if [[ -n "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}\${__orca_codex_hooks_enabled:-}" && -n "\${__orca_codex_binary:-}" && -x "\${__orca_codex_binary}" && ( -z "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" || -x "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" ) && ! ( -z "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" && -n "$__orca_codex_alias" ) ]]; then
  # Why the function reserved word: it suppresses alias expansion of the name,
  # which otherwise rewrites this header at parse time and aborts the whole file.
  function codex {
    [[ -z "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" ]] || "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex >/dev/null 2>&1 || :
    local __orca_codex_feature=""
    if [[ -n "\${__orca_codex_hooks_enabled:-}" && -n "\${ORCA_AGENT_HOOK_PORT:-}" && -n "\${ORCA_AGENT_HOOK_TOKEN:-}" && -n "\${ORCA_PANE_KEY:-}" ]] && ! __orca_codex_hooks_override "$@"; then
      __orca_codex_feature="$(__orca_codex_hooks_feature)"
    fi
    if [[ -n "$__orca_codex_feature" ]]; then
      command codex --enable "$__orca_codex_feature" "$@"
      return $?
    fi
    command codex "$@"
  }
fi
unset __orca_codex_binary __orca_codex_alias
`
}

export function getFishCodexShellLaunchPreflight(options: { hooksEnabled?: boolean } = {}): string {
  const hookSetup = options.hooksEnabled
    ? `set -g __orca_codex_hooks_enabled 1
function __orca_codex_hooks_override
  set index 1
  while test $index -le (count $argv)
    set value $argv[$index]
    switch $value
      case --
        return 1
      case --enable --disable
        set next $argv[(math $index + 1)]
        if test "$next" = hooks; or test "$next" = codex_hooks; return 0; end
      case '--enable=hooks' '--disable=hooks' '--enable=codex_hooks' '--disable=codex_hooks'
        return 0
      case '-c' '--config'
        set value $argv[(math $index + 1)]
      case '-c=*' '--config=*'
        set value (string split -m1 = $value)[2]
      case '-c?*'
        set value (string sub -s 3 $value)
    end
    if string match -qr '^features\\.(hooks|codex_hooks)([[:space:]]*=|=|$)' -- $value; return 0; end
    set index (math $index + 1)
  end
  return 1
end
function __orca_codex_hooks_feature
  set temp_root /tmp
  if set -q TMPDIR; and test -n "$TMPDIR"; set temp_root $TMPDIR; end
  set probe_file (command mktemp "$temp_root/orca-codex-version.XXXXXX" 2>/dev/null); or return
  command codex --version >$probe_file 2>/dev/null &
  set probe_pid $last_pid
  set remaining ${CODEX_VERSION_PROBE_ATTEMPTS}
  while command kill -0 $probe_pid 2>/dev/null; and test $remaining -gt 0
    command sleep ${CODEX_VERSION_PROBE_INTERVAL_SECONDS} 2>/dev/null; or break
    set remaining (math $remaining - 1)
  end
  if command kill -0 $probe_pid 2>/dev/null
    command kill -KILL $probe_pid 2>/dev/null
    wait $probe_pid 2>/dev/null
    command rm -f $probe_file
    return
  end
  wait $probe_pid 2>/dev/null
  set probe_status $status
  set version (string collect <$probe_file)
  command rm -f $probe_file
  if test "$probe_status" != 0; return; end
  set version (string split ' ' -- $version)[-1]
  if not string match -qr '^[0-9]+\\.[0-9]+\\.[0-9]+([-+].*)?$' -- $version; return; end
  set parts (string split . -- $version)
  if test $parts[1] -ge 1; or test $parts[2] -ge 129
    printf hooks
  else if test $parts[2] -ge 114
    printf codex_hooks
  end
end`
    : ''
  return `${hookSetup}
# Why captured: an absent codex expands to zero words and makes fish parse an invalid test.
set -l __orca_codex_type (type -t codex 2>/dev/null)
if test -n "$ORCA_CODEX_LAUNCH_PREFLIGHT$__orca_codex_hooks_enabled"; and test "$__orca_codex_type" = file; and begin; test -z "$ORCA_CODEX_LAUNCH_PREFLIGHT"; or test -x "$ORCA_CODEX_LAUNCH_PREFLIGHT"; end
  function codex
    if test -n "$ORCA_CODEX_LAUNCH_PREFLIGHT"
      command "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1; or true
    end
    set feature
    if test -n "$__orca_codex_hooks_enabled"; and test -n "$ORCA_AGENT_HOOK_PORT"; and test -n "$ORCA_AGENT_HOOK_TOKEN"; and test -n "$ORCA_PANE_KEY"; and not __orca_codex_hooks_override $argv
      set feature (__orca_codex_hooks_feature)
    end
    if test -n "$feature"
      command codex --enable "$feature" $argv
      return $status
    end
    command codex $argv
  end
end
set -e __orca_codex_type`
}

export function getPowerShellCodexShellLaunchPreflight(): string {
  return `$orcaCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:ORCA_CODEX_LAUNCH_PREFLIGHT -and $orcaCodexCommand -and
    $orcaCodexCommand.CommandType -in @("Application", "ExternalScript")) {
    function Global:codex {
        try {
            & $env:ORCA_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null
        } catch {
        }
        $orcaCodexExecutable = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCodexExecutable) {
            Write-Error "codex executable not found"
            $global:LASTEXITCODE = 127
            return
        }
        & $orcaCodexExecutable.Source @args
        $global:LASTEXITCODE = $LASTEXITCODE
    }
}
Remove-Variable orcaCodexCommand -ErrorAction SilentlyContinue`
}
