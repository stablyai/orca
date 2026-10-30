import { CLAUDE_HOOK_PARENT_CAPTURE } from './hook-process-capture'
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

function assertManagedScriptBaseName(scriptBaseName: string): void {
  if (!MANAGED_SCRIPT_BASE_NAME.test(scriptBaseName)) {
    throw new Error(`Invalid managed script base name: ${scriptBaseName}`)
  }
}

function buildPosixBranch(
  scriptBaseName: string,
  missingScriptFallback: string,
  options: { requireHome?: boolean } = {}
): string {
  const posixScript = `"\${HOME-}/.orca/agent-hooks/${scriptBaseName}.sh"`
  const homeGuard = options.requireHome ? '[ -n "${HOME-}" ] && ' : ''
  const parentCapture =
    scriptBaseName === 'claude-hook' || scriptBaseName === 'openclaude-hook'
      ? CLAUDE_HOOK_PARENT_CAPTURE
      : ''
  return `if ${homeGuard}[ -f ${posixScript} ] && [ -r ${posixScript} ] && [ -x ${posixScript} ]; then ${parentCapture}/bin/sh ${posixScript}; else ${missingScriptFallback}; fi`
}

export function wrapRuntimeHomePosixHookCommand(scriptBaseName: string): string {
  assertManagedScriptBaseName(scriptBaseName)
  return buildPosixBranch(scriptBaseName, POSIX_HOOK_STDIN_DRAIN_COMMAND, { requireHome: true })
}

export function wrapRuntimeHomeHookCommand(
  scriptBaseName: string,
  options: { neutralJsonWhenMissing?: boolean } = {}
): string {
  assertManagedScriptBaseName(scriptBaseName)
  // Grok rejects unresolved bare variables even in untaken platform branches.
  const windowsScript = `"\${HOME-}/.orca/agent-hooks/${scriptBaseName}.cmd"`
  const drain = POSIX_HOOK_STDIN_DRAIN_COMMAND
  const neutralJson = options.neutralJsonWhenMissing ? `printf '{}\\n'` : ''
  // POSIX drains before answering; Windows answers and checks Orca context before reading abandoned stdin.
  const posixMissingScriptFallback = neutralJson ? `${drain}; ${neutralJson}` : drain
  const windowsMissingScriptFallback = [
    ...(neutralJson ? [neutralJson] : []),
    WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD,
    drain
  ].join('; ')
  // Stdin ownership follows the caller platform even when HOME is missing.
  const missingScriptFallback = `case "\${OSTYPE-}" in msys*|cygwin*|win32*) ${windowsMissingScriptFallback} ;; *) ${posixMissingScriptFallback} ;; esac`
  const powershell = '"${SYSTEMROOT-}/System32/WindowsPowerShell/v1.0/powershell.exe"'
  const powershellFallback = options.neutralJsonWhenMissing ? "; Write-Output '{}'" : ''
  const powershellCommand = `$homePath = $env:HOME -replace '^/([A-Za-z])/', '$1:/'; $scriptPath = Join-Path $homePath '.orca\\agent-hooks\\${scriptBaseName}.cmd'; if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { & $scriptPath; exit $LASTEXITCODE }${powershellFallback}; ${WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD}; [Console]::In.ReadToEnd() | Out-Null; exit 0`
  const encodedCommand = encodeWindowsPowerShellHookCommand(powershellCommand)
  // Match native launcher switches to preserve AV compatibility across both entry paths.
  const powershellInvocation = `${powershell} ${WINDOWS_POWERSHELL_HOOK_SWITCHES} -EncodedCommand ${encodedCommand}`
  const encodedWindowsBranch = `if [ -f ${powershell} ]; then ${powershellInvocation}; else ${windowsMissingScriptFallback}; fi`
  const windowsBranch = `if [ -f ${windowsScript} ]; then case "\${HOME-}" in ${WINDOWS_GIT_BASH_RUNTIME_HOME_UNSAFE}) ${encodedWindowsBranch} ;; *) ${windowsScript} ;; esac; else ${windowsMissingScriptFallback}; fi`
  const posixBranch = buildPosixBranch(scriptBaseName, posixMissingScriptFallback)
  // Shell-owned OSTYPE avoids spawning a process for each platform check.
  return `if [ -z "\${HOME-}" ]; then ${missingScriptFallback}; else case "\${OSTYPE-}" in msys*|cygwin*|win32*) ${windowsBranch} ;; *) ${posixBranch} ;; esac; fi`
}
