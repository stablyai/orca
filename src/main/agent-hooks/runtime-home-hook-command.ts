import {
  POSIX_HOOK_STDIN_DRAIN_COMMAND,
  WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD,
  WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD
} from './hook-stdin-contract'
import {
  encodeWindowsPowerShellHookCommand,
  WINDOWS_POWERSHELL_HOOK_SWITCHES
} from './windows-powershell-hook-launcher'

const MANAGED_SCRIPT_BASE_NAME = /^[A-Za-z0-9_-]+$/
const WINDOWS_GIT_BASH_RUNTIME_HOME_UNSAFE = '*\\&*|*\\^*|*\\(*|*\\)*|*\\;*|*,*|*=*|*%*|*\\!*'

export function wrapRuntimeHomeHookCommand(
  scriptBaseName: string,
  options: { neutralJsonWhenMissing?: boolean } = {}
): string {
  if (!MANAGED_SCRIPT_BASE_NAME.test(scriptBaseName)) {
    throw new Error(`Invalid managed script base name: ${scriptBaseName}`)
  }
  // Why: default-form every var — a static hook precheck (Grok) rejects the whole command on a bare
  // reference it cannot resolve, even in a branch that platform never takes.
  const windowsScript = `"\${HOME-}/.orca/agent-hooks/${scriptBaseName}.cmd"`
  const posixScript = `"\${HOME-}/.orca/agent-hooks/${scriptBaseName}.sh"`
  const drain = POSIX_HOOK_STDIN_DRAIN_COMMAND
  const neutralJson = options.neutralJsonWhenMissing ? `printf '{}\\n'` : ''
  // Why two forms: the missing-script fallback owns stdin, so it follows the rule of the host
  // it lands on. POSIX callers close the pipe, so capture-first is safe there and a mid-write
  // exit stays visible as EPIPE (#8110). A Windows caller may abandon the pipe, so there the
  // answer comes first and the drain only runs with an Orca env behind it (#11549).
  const posixMissingScriptFallback = neutralJson ? `${drain}; ${neutralJson}` : drain
  const windowsMissingScriptFallback = [
    ...(neutralJson ? [neutralJson] : []),
    WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD,
    drain
  ].join('; ')
  // Why platform-selected even when HOME is unset: which stdin rule applies follows the
  // caller, not the reason the script could not be found.
  const missingScriptFallback = `case "\${OSTYPE-}" in msys*|cygwin*|win32*) ${windowsMissingScriptFallback} ;; *) ${posixMissingScriptFallback} ;; esac`
  const powershell = '"${SYSTEMROOT-}/System32/WindowsPowerShell/v1.0/powershell.exe"'
  const powershellFallback = options.neutralJsonWhenMissing ? "; Write-Output '{}'" : ''
  // Why the order: answer first, then the shared env guard, then own stdin — see wrapWindowsHookCommand.
  const powershellCommand = `$homePath = $env:HOME -replace '^/([A-Za-z])/', '$1:/'; $scriptPath = Join-Path $homePath '.orca\\agent-hooks\\${scriptBaseName}.cmd'; if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { & $scriptPath; exit $LASTEXITCODE }${powershellFallback}; ${WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD}; [Console]::In.ReadToEnd() | Out-Null; exit 0`
  const encodedCommand = encodeWindowsPowerShellHookCommand(powershellCommand)
  // Why: the Git Bash and native Windows launchers must spell the same switches — window suppression (#14815) and an AV verdict on the shape (#16003) both hit either path.
  const powershellInvocation = `${powershell} ${WINDOWS_POWERSHELL_HOOK_SWITCHES} -EncodedCommand ${encodedCommand}`
  const encodedWindowsBranch = `if [ -f ${powershell} ]; then ${powershellInvocation}; else ${windowsMissingScriptFallback}; fi`
  const windowsBranch = `if [ -f ${windowsScript} ]; then case "\${HOME-}" in ${WINDOWS_GIT_BASH_RUNTIME_HOME_UNSAFE}) ${encodedWindowsBranch} ;; *) ${windowsScript} ;; esac; else ${windowsMissingScriptFallback}; fi`
  const posixBranch = `if [ -f ${posixScript} ] && [ -r ${posixScript} ] && [ -x ${posixScript} ]; then /bin/sh ${posixScript}; else ${posixMissingScriptFallback}; fi`
  // Why: OSTYPE is shell-owned, so platform selection adds no process to every hook invocation.
  return `if [ -z "\${HOME-}" ]; then ${missingScriptFallback}; else case "\${OSTYPE-}" in msys*|cygwin*|win32*) ${windowsBranch} ;; *) ${posixBranch} ;; esac; fi`
}
