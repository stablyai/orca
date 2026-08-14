import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from './hook-stdin-contract'

const MANAGED_SCRIPT_BASE_NAME = /^[A-Za-z0-9_-]+$/
const WINDOWS_GIT_BASH_RUNTIME_HOME_UNSAFE = '*\\&*|*\\^*|*\\(*|*\\)*|*\\;*|*,*|*=*|*%*|*\\!*'

export function wrapRuntimeHomeHookCommand(scriptBaseName: string): string {
  if (!MANAGED_SCRIPT_BASE_NAME.test(scriptBaseName)) {
    throw new Error(`Invalid managed script base name: ${scriptBaseName}`)
  }
  const windowsScript = `"$HOME/.orca/agent-hooks/${scriptBaseName}.cmd"`
  const posixScript = `"$HOME/.orca/agent-hooks/${scriptBaseName}.sh"`
  const drain = POSIX_HOOK_STDIN_DRAIN_COMMAND
  const powershell = '"$SYSTEMROOT/System32/WindowsPowerShell/v1.0/powershell.exe"'
  const powershellCommand = `$homePath = $env:HOME -replace '^/([A-Za-z])/', '$1:/'; $scriptPath = Join-Path $homePath '.orca\\agent-hooks\\${scriptBaseName}.cmd'; if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { & $scriptPath; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0`
  const encodedCommand = Buffer.from(powershellCommand, 'utf16le').toString('base64')
  const powershellInvocation = `${powershell} -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`
  const encodedWindowsBranch = `if [ -f ${powershell} ]; then ${powershellInvocation}; else ${drain}; fi`
  const windowsBranch = `if [ -f ${windowsScript} ]; then case "$HOME" in ${WINDOWS_GIT_BASH_RUNTIME_HOME_UNSAFE}) ${encodedWindowsBranch} ;; *) ${windowsScript} ;; esac; else ${drain}; fi`
  const posixBranch = `if [ -f ${posixScript} ] && [ -r ${posixScript} ] && [ -x ${posixScript} ]; then /bin/sh ${posixScript}; else ${drain}; fi`
  // Why: OSTYPE is shell-owned, so platform selection adds no process to every hook invocation.
  return `if [ -z "\${HOME-}" ]; then ${drain}; else case "\${OSTYPE-}" in msys*|cygwin*|win32*) ${windowsBranch} ;; *) ${posixBranch} ;; esac; fi`
}
