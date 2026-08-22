import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

const DEV_LAUNCHER_DIR = ['cli', 'bin']
const DEV_COMMAND_NAME = 'mcode-dev'

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

/** Absolute path of the MCode CLI the preflight must execute, or null to skip it.
 *
 *  Why absolute: the value rides in MCODE_CODEX_LAUNCH_PREFLIGHT and is invoked
 *  from the codex() wrapper, which shell-ready emits *after* the user's profile
 *  scripts run. Those scripts routinely rewrite PATH, so an unqualified name
 *  would be resolved against a PATH MCode neither controls nor can predict —
 *  handing MCode's managed Codex environment to an unidentified program. When no
 *  path verifies, skipping the preflight is the predictable degradation. */
export function resolveCodexShellLaunchPreflightCommand(
  options: CodexShellLaunchPreflightCommandOptions
): string | null {
  if (!options.hooksEnabled || options.isWsl || !options.managedHomePath) {
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
  return candidate && isExecutableFileOnDisk(candidate, platform) ? candidate : null
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
__mcode_codex_binary="$(command -v codex 2>/dev/null || :)"
if [[ -n "\${MCODE_CODEX_LAUNCH_PREFLIGHT:-}" && -n "\${__mcode_codex_binary:-}" && -x "\${__mcode_codex_binary}" ]]; then
  codex() {
    "\${MCODE_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex >/dev/null 2>&1 || :
    command codex "$@"
  }
fi
unset __mcode_codex_binary
`
}

export function getFishCodexShellLaunchPreflight(): string {
  return `if test -n "$MCODE_CODEX_LAUNCH_PREFLIGHT"; and test (type -t codex 2>/dev/null) = file
  function codex
    command "$MCODE_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1; or true
    command codex $argv
  end
end`
}

export function getPowerShellCodexShellLaunchPreflight(): string {
  return `$mcodeCodexCommand = Get-Command codex -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notlike '*\\WindowsApps\\OpenAI.Codex_*\\app\\resources\\codex*' } |
    Select-Object -First 1
if ($env:MCODE_CODEX_LAUNCH_PREFLIGHT -and $mcodeCodexCommand -and
    $mcodeCodexCommand.CommandType -in @("Application", "ExternalScript")) {
    function Global:codex {
        try {
            & $env:MCODE_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null
        } catch {
        }
        $mcodeCodexExecutable = Get-Command codex -All -CommandType Application,ExternalScript -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -notlike '*\\WindowsApps\\OpenAI.Codex_*\\app\\resources\\codex*' } |
            Select-Object -First 1
        if (-not $mcodeCodexExecutable) {
            Write-Error "codex executable not found"
            $global:LASTEXITCODE = 127
            return
        }
        & $mcodeCodexExecutable.Source @args
        $global:LASTEXITCODE = $LASTEXITCODE
    }
}
Remove-Variable mcodeCodexCommand -ErrorAction SilentlyContinue`
}
