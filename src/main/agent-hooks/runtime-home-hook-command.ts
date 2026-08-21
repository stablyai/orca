import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from './hook-stdin-contract'
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
  const missingScriptFallback = options.neutralJsonWhenMissing ? `${drain}; printf '{}\\n'` : drain
  const powershell = '"${SYSTEMROOT-}/System32/WindowsPowerShell/v1.0/powershell.exe"'
  const powershellFallback = options.neutralJsonWhenMissing ? "; Write-Output '{}'" : ''
  const powershellCommand = `$homePath = $env:HOME -replace '^/([A-Za-z])/', '$1:/'; $scriptPath = Join-Path $homePath '.orca\\agent-hooks\\${scriptBaseName}.cmd'; if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { & $scriptPath; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null${powershellFallback}; exit 0`
  const encodedCommand = encodeWindowsPowerShellHookCommand(powershellCommand)
  // Why: the Git Bash and native Windows launchers must suppress windows identically (#14815).
  const powershellInvocation = `${powershell} ${WINDOWS_POWERSHELL_HOOK_SWITCHES} -EncodedCommand ${encodedCommand}`
  const encodedWindowsBranch = `if [ -f ${powershell} ]; then ${powershellInvocation}; else ${missingScriptFallback}; fi`
  const windowsBranch = `if [ -f ${windowsScript} ]; then case "\${HOME-}" in ${WINDOWS_GIT_BASH_RUNTIME_HOME_UNSAFE}) ${encodedWindowsBranch} ;; *) ${windowsScript} ;; esac; else ${missingScriptFallback}; fi`
  const posixBranch = `if [ -f ${posixScript} ] && [ -r ${posixScript} ] && [ -x ${posixScript} ]; then /bin/sh ${posixScript}; else ${missingScriptFallback}; fi`
  // Why: OSTYPE is shell-owned, so platform selection adds no process to every hook invocation.
  return `if [ -z "\${HOME-}" ]; then ${missingScriptFallback}; else case "\${OSTYPE-}" in msys*|cygwin*|win32*) ${windowsBranch} ;; *) ${posixBranch} ;; esac; fi`
}
