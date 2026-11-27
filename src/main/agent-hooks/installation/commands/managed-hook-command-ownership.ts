import { WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME } from './windows-native-hook-executable'
import { isOrcaPosixCondition, unquoteSinglePosixToken } from './posix-condition-clauses'
import { HOOK_PARENT_CAPTURE } from '../scripts/hook-process-capture'
import {
  POSIX_HOOK_STDIN_BACKGROUND_DRAIN_COMMAND,
  POSIX_HOOK_STDIN_DRAIN_COMMAND,
  WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD,
  WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD
} from '../scripts/hook-stdin-contract'

const SHELL_METACHAR_PATTERN = /[;&|<>\r\n`]|(?:\$\()/
const DIRECT_POSIX_SHELL_PREFIX = /^(?:\/bin\/sh|sh|bash)[ \t]+/
const SIMPLE_ENV_ASSIGNMENT =
  /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'(?:\\''[^']*')*|"[^"\r\n`$]*"|[^\s;&|<>\r\n`"'$]+)[ \t]+/
const POWERSHELL_ENCODED_COMMAND =
  /^(?:if\s+defined\s+ORCA_PANE_KEY\s+)?(?:"(?:[^"\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"|'(?:[^'\r\n]*[\\/])?(?:powershell|pwsh)(?:\.exe)?'|(?:[^\s;&|<>\r\n"']*[\\/])?(?:powershell|pwsh)(?:\.exe)?)(?:\s+-[A-Za-z]+(?:\s+[A-Za-z]+)?)*\s+-EncodedCommand\s+([A-Za-z0-9+/=]+)$/i
const POWERSHELL_PROGRESS_PREFIX = /^\$ProgressPreference\s*=\s*'SilentlyContinue';\s*/i
const POWERSHELL_POLICY_PREFIX =
  /^(?:try\s*\{\s*Set-ExecutionPolicy\s+-Scope\s+Process\s+-ExecutionPolicy\s+Bypass\s+-Force\s+-ErrorAction\s+SilentlyContinue\s*\}\s*catch\s*\{\s*\};\s*|\$env:PSExecutionPolicyPreference\s*=\s*'Bypass';\s*)/i
const POWERSHELL_UTF8_PREFIX =
  /^\[Console\]::InputEncoding\s*=\s*New-Object\s+System\.Text\.UTF8Encoding;\s*\$OutputEncoding\s*=\s*\[Console\]::InputEncoding;\s*/i
const WINDOWS_CMD_CODEX_LAUNCHER =
  /^(?:[^\s;&|<>\r\n"']*[\\/])?cmd(?:\.exe)?\s+--%\s+\/d\s+\/v:off\s+\/c\s+@"([^"\r\n]+)"$/i
const WINDOWS_CMD_DIRECT_LAUNCHER =
  /^(?:[^\s;&|<>\r\n"']*[\\/])?cmd(?:\.exe)?\s+\/d\s+\/c\s+([^\s;&|<>\r\n"']+)(?:\s+([A-Za-z0-9_.-]+))?$/i
const POWERSHELL_ENV_ASSIGNMENT = /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*'(?:[^']|'')*';\s*/i
const POWERSHELL_TEST_PATH_BRANCH =
  /^if\s*\(\s*Test-Path\s+-LiteralPath\s+'((?:[^']|'')+)'\s+-PathType\s+Leaf\s*\)\s*\{\s*&\s*'((?:[^']|'')+)';\s*exit\s+\$LASTEXITCODE\s*\}(.*)$/i
const POWERSHELL_RUNTIME_HOME_BRANCH =
  /^\$homePath\s*=\s*\$env:HOME\s+-replace\s+'\^\/\(\[A-Za-z\]\)\/',\s*'\$1:\/';\s*\$scriptPath\s*=\s*Join-Path\s+\$homePath\s+'\.orca\\agent-hooks\\([^'\\]+)';\s*if\s*\(\s*Test-Path\s+-LiteralPath\s+\$scriptPath\s+-PathType\s+Leaf\s*\)\s*\{\s*&\s*\$scriptPath;\s*exit\s+\$LASTEXITCODE\s*\}(.*)$/i
const POSIX_WRAPPER_LEADING_PREFIXES = [
  /^:\s+orca-agent-hook-form=\d+;\s*/,
  new RegExp(`^${escapeRegExp(HOOK_PARENT_CAPTURE)}`),
  /^\[ -n "\$\{ORCA_PANE_KEY-[^"\r\n]*" \]\s*\|\|\s*exit 0;\s*/
]

export const NATIVE_EXE_SUFFIX = new RegExp(
  `(?:^|/)agent-hooks/${escapeRegExp(WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME)}$`
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isManagedScriptPathValue(pathValue: string, scriptNames: ReadonlySet<string>): boolean {
  const normalized = pathValue.replaceAll('\\', '/')
  const match = normalized.match(/(?:^|\/)agent-hooks\/([^/]+)$/)
  return match !== null && scriptNames.has(match[1])
}

function isManagedScriptPath(rawPath: string, scriptNames: ReadonlySet<string>): boolean {
  const unquoted = unquoteSinglePosixToken(rawPath)
  return unquoted !== null && isManagedScriptPathValue(unquoted, scriptNames)
}

function isManagedDirectShellCommand(command: string, scriptNames: ReadonlySet<string>): boolean {
  let rest = command.trim()
  if (rest.startsWith(HOOK_PARENT_CAPTURE)) {
    rest = rest.slice(HOOK_PARENT_CAPTURE.length).trimStart()
  }
  while (SIMPLE_ENV_ASSIGNMENT.test(rest)) {
    rest = rest.replace(SIMPLE_ENV_ASSIGNMENT, '')
  }
  if (rest.endsWith(' || :')) {
    rest = rest.slice(0, -' || :'.length).trimEnd()
  }
  const withoutShell = rest.replace(DIRECT_POSIX_SHELL_PREFIX, '')
  return isManagedScriptPath(withoutShell, scriptNames)
}

function isManagedNativeExecutableCommand(command: string, agentName: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || SHELL_METACHAR_PATTERN.test(trimmed)) {
    return false
  }
  let exeToken: string
  let rest: string
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]
    const closeIdx = trimmed.indexOf(quote, 1)
    if (closeIdx === -1) {
      return false
    }
    exeToken = trimmed.slice(1, closeIdx)
    rest = trimmed.slice(closeIdx + 1)
  } else {
    const splitIdx = trimmed.search(/\s/)
    if (splitIdx === -1) {
      return false
    }
    exeToken = trimmed.slice(0, splitIdx)
    rest = trimmed.slice(splitIdx)
  }
  if (!NATIVE_EXE_SUFFIX.test(exeToken.replaceAll('\\', '/'))) {
    return false
  }
  const args = rest.trim().split(/\s+/).filter(Boolean)
  if (args.length === 0 || args[0] !== agentName) {
    return false
  }
  return args.length === 1 || (args.length === 2 && /^[A-Za-z0-9_.-]+$/.test(args[1]))
}

function isOrcaPowerShellTail(tail: string): boolean {
  let rest = tail.trim()
  if (rest.startsWith(';')) {
    rest = rest.slice(1).trimStart()
  }
  if (!rest) {
    return true
  }
  rest = rest.replace(/^Write-Output\s+'(?:[^']|'')*';\s*/i, '')
  if (rest.startsWith(WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD)) {
    rest = rest.slice(WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD.length).trimStart()
    if (rest.startsWith(';')) {
      rest = rest.slice(1).trimStart()
    }
  }
  rest = rest.replace(/^\[Console\]::In\.ReadToEnd\(\)\s*\|\s*Out-Null(?:;\s*)?/i, '')
  rest = rest.replace(/^exit\s+0$/i, '')
  return rest.trim().length === 0
}

function isManagedPowerShellEncodedCommand(
  command: string,
  scriptNames: ReadonlySet<string>
): boolean {
  const match = command.trim().match(POWERSHELL_ENCODED_COMMAND)
  if (!match) {
    return false
  }
  let decoded: string
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf16le').trim()
  } catch {
    return false
  }
  let rest = decoded
    .replace(POWERSHELL_PROGRESS_PREFIX, '')
    .replace(POWERSHELL_POLICY_PREFIX, '')
    .replace(POWERSHELL_UTF8_PREFIX, '')
  while (POWERSHELL_ENV_ASSIGNMENT.test(rest)) {
    rest = rest.replace(POWERSHELL_ENV_ASSIGNMENT, '')
  }

  const literalMatch = rest.match(POWERSHELL_TEST_PATH_BRANCH)
  if (literalMatch) {
    const firstPath = literalMatch[1].replaceAll("''", "'")
    const secondPath = literalMatch[2].replaceAll("''", "'")
    return (
      isManagedScriptPathValue(firstPath, scriptNames) &&
      isManagedScriptPathValue(secondPath, scriptNames) &&
      isOrcaPowerShellTail(literalMatch[3])
    )
  }

  const runtimeHomeMatch = rest.match(POWERSHELL_RUNTIME_HOME_BRANCH)
  return (
    runtimeHomeMatch !== null &&
    scriptNames.has(runtimeHomeMatch[1]) &&
    isOrcaPowerShellTail(runtimeHomeMatch[2])
  )
}

function isOrcaPosixFallback(fallback: string): boolean {
  let rest = fallback.trim()
  rest = rest.replace(/^printf[ \t]+'%s\\n'[ \t]+'[^']*'(?:\\''[^']*')*;\s*/, '')
  rest = rest.replace(/^printf[ \t]+'\{\}\\n';\s*/, '')
  if (rest.startsWith(WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD)) {
    rest = rest.slice(WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD.length).trimStart()
    if (rest.startsWith(';')) {
      rest = rest.slice(1).trimStart()
    }
  }
  if (rest.endsWith("; printf '{}\\n'")) {
    rest = rest.slice(0, -"; printf '{}\\n'".length).trimEnd()
  }
  return (
    rest === '' ||
    rest === ':' ||
    rest === 'exit 0' ||
    rest === POSIX_HOOK_STDIN_DRAIN_COMMAND ||
    rest === POSIX_HOOK_STDIN_BACKGROUND_DRAIN_COMMAND ||
    /^cat[ \t]+>\/dev\/null[ \t]+2>&1[ \t]*\|\|[ \t]*:$/.test(rest)
  )
}

function isOrcaRuntimeHomeFallback(fallback: string): boolean {
  const match = fallback
    .trim()
    .match(
      /^case\s+"\$\{OSTYPE-\}"\s+in\s+msys\*\|cygwin\*\|win32\*\)\s+([\s\S]+?)\s+;;\s+\*\)\s+([\s\S]+?)\s+;;\s+esac$/
    )
  return match !== null && isOrcaPosixFallback(match[1]) && isOrcaPosixFallback(match[2])
}

function isOrcaRuntimeHomeWindowsBranch(branch: string, scriptNames: ReadonlySet<string>): boolean {
  const outer = branch
    .trim()
    .match(
      /^if\s+\[\s+-f\s+("\$\{HOME-\}\/\.orca\/agent-hooks\/[^"]+")\s+\];\s+then\s+case\s+"\$\{HOME-\}"\s+in\s+[\s\S]+?\)\s+if\s+\[\s+-f\s+"\$\{SYSTEMROOT-\}\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe"\s+\];\s+then\s+([\s\S]+?);\s+else\s+([\s\S]+?);\s+fi\s+;;\s+\*\)\s+("\$\{HOME-\}\/\.orca\/agent-hooks\/[^"]+")\s+;;\s+esac;\s+else\s+([\s\S]+?);\s+fi$/
    )
  return (
    outer !== null &&
    isManagedScriptPath(outer[1], scriptNames) &&
    isManagedPowerShellEncodedCommand(outer[2], scriptNames) &&
    isOrcaPosixFallback(outer[3]) &&
    isManagedScriptPath(outer[4], scriptNames) &&
    isOrcaPosixFallback(outer[5])
  )
}

function isManagedPosixIfWrapper(command: string, scriptNames: ReadonlySet<string>): boolean {
  const trimmed = command.trim()
  if (!trimmed.startsWith('if ') || !trimmed.endsWith('; fi')) {
    return false
  }
  let rest = trimmed.slice('if '.length, -'; fi'.length)
  let isFirst = true
  let hasManagedBranch = false
  while (rest.length > 0) {
    if (!isFirst && rest.startsWith('; else ')) {
      return hasManagedBranch && isOrcaPosixFallback(rest.slice('; else '.length))
    }
    if (!isFirst) {
      if (!rest.startsWith('; elif ')) {
        return false
      }
      rest = rest.slice('; elif '.length)
    }
    isFirst = false
    const thenIdx = rest.indexOf('; then ')
    if (thenIdx === -1) {
      return false
    }
    const condition = rest.slice(0, thenIdx)
    const afterThen = rest.slice(thenIdx + '; then '.length)
    const nextElif = afterThen.indexOf('; elif ')
    const nextElse = afterThen.indexOf('; else ')
    const nextIdx =
      nextElif !== -1 && (nextElse === -1 || nextElif < nextElse) ? nextElif : nextElse
    const body = nextIdx === -1 ? afterThen : afterThen.slice(0, nextIdx)
    if (
      !isOrcaPosixCondition(condition, (path) => isManagedScriptPath(path, scriptNames)) ||
      !isManagedDirectShellCommand(body, scriptNames)
    ) {
      return false
    }
    hasManagedBranch = true
    rest = nextIdx === -1 ? '' : afterThen.slice(nextIdx)
  }
  return hasManagedBranch
}

function isManagedPosixWrapperCommand(command: string, scriptNames: ReadonlySet<string>): boolean {
  let rest = command.trim()
  if (rest.startsWith('/bin/sh -c ')) {
    const unwrapped = unquoteSinglePosixToken(rest.slice('/bin/sh -c '.length))
    if (!unwrapped) {
      return false
    }
    rest = unwrapped.trim()
  }
  for (const prefix of POSIX_WRAPPER_LEADING_PREFIXES) {
    rest = rest.replace(prefix, '')
  }

  const runtimeHomeMatch = rest.match(
    /^if\s+\[\s+-z\s+"\$\{HOME-\}"\s+\];\s+then\s+([\s\S]+?);\s+else\s+case\s+"\$\{OSTYPE-\}"\s+in\s+msys\*\|cygwin\*\|win32\*\)\s+([\s\S]+?)\s+;;\s+\*\)\s+(if\s+[\s\S]+?)\s+;;\s+esac;\s+fi$/
  )
  if (runtimeHomeMatch) {
    return (
      isOrcaRuntimeHomeFallback(runtimeHomeMatch[1]) &&
      isOrcaRuntimeHomeWindowsBranch(runtimeHomeMatch[2], scriptNames) &&
      isManagedPosixIfWrapper(runtimeHomeMatch[3], scriptNames)
    )
  }

  return isManagedPosixIfWrapper(rest, scriptNames)
}

function isManagedWindowsCmdCommand(command: string, scriptNames: ReadonlySet<string>): boolean {
  const trimmed = command.trim()
  const codexMatch = trimmed.match(WINDOWS_CMD_CODEX_LAUNCHER)
  if (codexMatch) {
    return isManagedScriptPathValue(codexMatch[1], scriptNames)
  }
  const directMatch = trimmed.match(WINDOWS_CMD_DIRECT_LAUNCHER)
  return directMatch !== null && isManagedScriptPathValue(directMatch[1], scriptNames)
}

/** True only when Orca owns the entire command string, never for composite user commands. */
export function isOwnedManagedHookCommand(
  command: string,
  scriptNames: ReadonlySet<string>,
  agentName: string
): boolean {
  return (
    isManagedDirectShellCommand(command, scriptNames) ||
    isManagedNativeExecutableCommand(command, agentName) ||
    isManagedWindowsCmdCommand(command, scriptNames) ||
    isManagedPowerShellEncodedCommand(command, scriptNames) ||
    isManagedPosixWrapperCommand(command, scriptNames)
  )
}
