const CODEX_NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'exec',
  'e',
  'review',
  'logout',
  'mcp',
  'plugin',
  'mcp-server',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'execpolicy',
  'apply',
  'a',
  'cloud',
  'cloud-tasks',
  'responses-api-proxy',
  'stdio-to-uds',
  'exec-server',
  'features',
  'help',
  'version'
])
const CODEX_NON_INTERACTIVE_CLOUD_SUBCOMMANDS = new Set([
  'exec',
  'status',
  'list',
  'apply',
  'diff',
  'help'
])
const CODEX_NON_INTERACTIVE_LOGIN_SUBCOMMANDS = new Set(['status', 'help'])
const CODEX_GLOBAL_FLAGS_WITH_VALUES = new Set([
  '--config',
  '-c',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '--image',
  '-i',
  '--model',
  '-m',
  '--local-provider',
  '--profile',
  '-p',
  '--sandbox',
  '-s',
  '--cd',
  '-C',
  '--add-dir',
  '--ask-for-approval',
  '-a'
])
const CODEX_GLOBAL_BOOLEAN_FLAGS = new Set([
  '--oss',
  '--dangerously-bypass-approvals-and-sandbox',
  '--search',
  '--no-alt-screen',
  '--help',
  '-h',
  '--version',
  '-V'
])
const CODEX_LOGIN_FLAGS_WITH_VALUES = new Set(['-c', '--config', '--enable', '--disable'])
const CODEX_LOGIN_BOOLEAN_FLAGS = new Set([
  '--with-api-key',
  '--with-access-token',
  '--device-auth',
  '--help',
  '-h'
])
const CODEX_CLOUD_FLAGS_WITH_VALUES = new Set(['-c', '--config', '--enable', '--disable'])
const CODEX_CLOUD_BOOLEAN_FLAGS = new Set(['--help', '-h', '--version', '-V'])

type CodexCommandToken = {
  value: string
  index: number
}

function tokenizeLeadingShellWords(command: string, limit: number): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        if (tokens.length >= limit) {
          return tokens
        }
        current = ''
      }
      continue
    }
    current += ch
  }

  if (current && tokens.length < limit) {
    tokens.push(current)
  }
  return tokens
}

function commandBasename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

function isCodexExecutable(command: string): boolean {
  return command === 'codex' || command === 'codex.exe' || command === 'codex.cmd'
}

function isShellAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function stripShellLaunchPrefix(tokens: string[]): string[] {
  const remaining = [...tokens]
  while (remaining[0] && isShellAssignment(remaining[0])) {
    remaining.shift()
  }
  if (remaining[0] && commandBasename(remaining[0]) === 'env') {
    remaining.shift()
    while (remaining[0]) {
      const token = remaining[0]
      if (isShellAssignment(token)) {
        remaining.shift()
        continue
      }
      if (token === '-u' || token === '--unset') {
        remaining.splice(0, 2)
        continue
      }
      if (token.startsWith('--unset=')) {
        remaining.shift()
        continue
      }
      if (token.startsWith('-')) {
        remaining.shift()
        continue
      }
      break
    }
  }
  return remaining
}

function codexGlobalOptionName(token: string): string {
  const separatorIndex = token.indexOf('=')
  return separatorIndex === -1 ? token : token.slice(0, separatorIndex)
}

function isHelpFlag(token: string): boolean {
  return token === '--help' || token === '-h'
}

function isVersionFlag(token: string): boolean {
  return token === '--version' || token === '-V'
}

function findCodexSubcommand(
  tokens: string[],
  startIndex: number,
  flagsWithValues: Set<string>,
  booleanFlags: Set<string>
): CodexCommandToken | null {
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      return tokens[i + 1] ? { value: '<prompt>', index: i + 1 } : null
    }

    const optionName = codexGlobalOptionName(token)
    if (isHelpFlag(optionName) || isVersionFlag(optionName)) {
      return { value: isVersionFlag(optionName) ? 'version' : 'help', index: i }
    }
    if (flagsWithValues.has(optionName)) {
      if (optionName === token) {
        i += 1
      }
      continue
    }
    if (booleanFlags.has(optionName)) {
      continue
    }
    return { value: token, index: i }
  }
  return null
}

function isNonInteractiveCodexSubcommand(tokens: string[]): boolean {
  const subcommand = findCodexSubcommand(
    tokens,
    1,
    CODEX_GLOBAL_FLAGS_WITH_VALUES,
    CODEX_GLOBAL_BOOLEAN_FLAGS
  )
  if (!subcommand) {
    return false
  }

  const normalizedSubcommand = subcommand.value.toLowerCase()
  if (normalizedSubcommand === 'login') {
    // Why: bare `codex login` displays an auth flow; only explicit status/help
    // or stdin-fed token modes are safe to leave in a background PTY.
    const loginStartIndex = subcommand.index + 1
    const loginSubcommand = findCodexSubcommand(
      tokens,
      loginStartIndex,
      CODEX_LOGIN_FLAGS_WITH_VALUES,
      CODEX_LOGIN_BOOLEAN_FLAGS
    )
    return (
      tokens
        .slice(loginStartIndex)
        .some((token) => token === '--with-api-key' || token === '--with-access-token') ||
      tokens.slice(loginStartIndex).some(isHelpFlag) ||
      (loginSubcommand !== null &&
        CODEX_NON_INTERACTIVE_LOGIN_SUBCOMMANDS.has(loginSubcommand.value.toLowerCase()))
    )
  }
  if (normalizedSubcommand === 'cloud') {
    // Why: bare `codex cloud` opens the interactive cloud browser, while its
    // named child commands are plain one-shot commands.
    const cloudStartIndex = subcommand.index + 1
    const cloudSubcommand = findCodexSubcommand(
      tokens,
      cloudStartIndex,
      CODEX_CLOUD_FLAGS_WITH_VALUES,
      CODEX_CLOUD_BOOLEAN_FLAGS
    )
    return (
      tokens.slice(cloudStartIndex).some((token) => isHelpFlag(token) || isVersionFlag(token)) ||
      (cloudSubcommand !== null &&
        CODEX_NON_INTERACTIVE_CLOUD_SUBCOMMANDS.has(cloudSubcommand.value.toLowerCase()))
    )
  }

  return CODEX_NON_INTERACTIVE_SUBCOMMANDS.has(normalizedSubcommand)
}

export function shouldForceVisibleCodexTerminal(command: string | undefined): boolean {
  if (!command) {
    return false
  }

  const tokens = stripShellLaunchPrefix(
    tokenizeLeadingShellWords(command.trim(), 32).filter((token) => token.length > 0)
  )

  const executable = tokens[0] ? commandBasename(tokens[0]) : ''
  if (!isCodexExecutable(executable)) {
    return false
  }

  return !isNonInteractiveCodexSubcommand(tokens)
}
