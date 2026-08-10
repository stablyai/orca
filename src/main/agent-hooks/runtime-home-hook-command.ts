import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from './hook-stdin-contract'

const MANAGED_SCRIPT_BASE_NAME = /^[A-Za-z0-9_-]+$/

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
  const windowsBranch = `if [ -f ${windowsScript} ]; then case "$HOME" in *[!A-Za-z0-9_.:/~-]*) ${encodedWindowsBranch} ;; *) ${windowsScript} ;; esac; else ${drain}; fi`
  const posixBranch = `if [ -f ${posixScript} ] && [ -r ${posixScript} ] && [ -x ${posixScript} ]; then /bin/sh ${posixScript}; else ${drain}; fi`
  // Why: synced settings must select the destination runtime, not the installer profile or OS.
  return `if [ -z "\${HOME-}" ]; then ${drain}; else case "$(command -p uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) ${windowsBranch} ;; *) ${posixBranch} ;; esac; fi`
}
