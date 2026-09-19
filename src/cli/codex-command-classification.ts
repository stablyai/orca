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

type ShellWord = {
  value: string
  quoted: boolean
}

/** Yields shell words and whether each word started with a quote. */
function* tokenizeLeadingShellWords(command: string): Generator<ShellWord, undefined> {
  let current = ''
  let quote: '"' | "'" | null = null
  let quoted = false

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
      if (!current) {
        quoted = true
      }
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        yield { value: current, quoted }
        current = ''
        quoted = false
      }
      continue
    }
    current += ch
  }

  if (current) {
    yield { value: current, quoted }
  }
}

function commandBasename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

function isCodexExecutable(command: string): boolean {
  return command === 'codex' || command === 'codex.exe' || command === 'codex.cmd'
}

function isClaudeExecutable(command: string): boolean {
  return command === 'claude' || command === 'claude.exe' || command === 'claude.cmd'
}

/** True when token is a NAME=value word the shell or env would treat as an assignment. */
function isShellAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

/** True when NAME=value is unquoted, so the shell would apply it as a prefix assignment. */
function isUnquotedShellAssignment(token: ShellWord | undefined): boolean {
  // Why: quoted `NAME=value` is a command name, not a shell assignment.
  return Boolean(token && !token.quoted && isShellAssignment(token.value))
}

/** Drop leading assignments, one `exec`, and `env` argv until the real command. */
function stripShellLaunchPrefix(tokens: Generator<ShellWord, undefined>): string[] {
  let token = tokens.next().value
  while (isUnquotedShellAssignment(token)) {
    token = tokens.next().value
  }
  if (token?.value === 'exec') {
    token = tokens.next().value
  }
  if (token && commandBasename(token.value) === 'env') {
    token = tokens.next().value
    while (token) {
      if (token.value === '-u' || token.value === '--unset') {
        tokens.next()
      } else if (!isShellAssignment(token.value) && !token.value.startsWith('-')) {
        break
      }
      token = tokens.next().value
    }
  }

  const remaining: string[] = []
  while (token) {
    remaining.push(token.value)
    // Why: bound provider argv scanning without counting environment assignments.
    if (remaining.length >= 32) {
      break
    }
    token = tokens.next().value
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

function isClaudePrintFlag(token: string): boolean {
  const optionName = codexGlobalOptionName(token)
  return optionName === '-p' || optionName === '--print'
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

/** True when `command` launches interactive Codex, including `exec`/`env` prefixes. */
export function shouldUseRendererBackedCodexTerminal(command: string | undefined): boolean {
  if (!command) {
    return false
  }

  const tokens = stripShellLaunchPrefix(tokenizeLeadingShellWords(command.trim()))

  const executable = tokens[0] ? commandBasename(tokens[0]) : ''
  if (!isCodexExecutable(executable)) {
    return false
  }

  return !isNonInteractiveCodexSubcommand(tokens)
}

/** True when `command` launches interactive Codex or Claude, including `exec`/`env` prefixes. */
export function shouldUseRendererBackedInteractiveTerminal(command: string | undefined): boolean {
  if (!command) {
    return false
  }

  const tokens = stripShellLaunchPrefix(tokenizeLeadingShellWords(command.trim()))

  const executable = tokens[0] ? commandBasename(tokens[0]) : ''
  if (isCodexExecutable(executable)) {
    return !isNonInteractiveCodexSubcommand(tokens)
  }
  if (isClaudeExecutable(executable)) {
    return !tokens
      .slice(1)
      .some((token) => isHelpFlag(token) || isVersionFlag(token) || isClaudePrintFlag(token))
  }
  return false
}
