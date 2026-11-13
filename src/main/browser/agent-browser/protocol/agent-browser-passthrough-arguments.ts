import { BrowserError } from '../../browser-error'

export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) {
    args.push(current)
  }
  return args
}

/** Splits a command line the way agent-browser splits each `batch` command (backslash escapes, quotes). */
export function splitAgentBrowserCommandLine(input: string): string[] {
  const args: string[] = []
  let value = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const char of input.trim()) {
    if (escaped) {
      value += char
      escaped = false
    } else if (char === '\\' && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (char === quote) {
        quote = null
      } else {
        value += char
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (value) {
        args.push(value)
        value = ''
      }
    } else {
      value += char
    }
  }
  if (escaped) {
    value += '\\'
  }
  if (quote) {
    throw new BrowserError('invalid_argument', 'Browser command has an unclosed quote.')
  }
  if (value) {
    args.push(value)
  }
  return args
}

// agent-browser's global options (0.39 through 0.43). It reads them anywhere in argv, even after
// a command, and they choose the browser, session and launch, which Orca owns.
const GLOBAL_OPTIONS = new Set([
  '--action-policy',
  '--allow-file-access',
  '--allowed-domains',
  '--annotate',
  '--args',
  '--auto-connect',
  '--ca-cert',
  '--capture',
  '--cdp',
  '--cdp-headers',
  '--color-scheme',
  '--config',
  '--confirm-actions',
  '--confirm-interactive',
  '--content-boundaries',
  '--debug',
  '--device',
  '--download-path',
  '--enable',
  '--engine',
  '--executable-path',
  '--extension',
  '--fix',
  '--headed',
  '--headers',
  '--hide-scrollbars',
  '--idle-timeout',
  '--ignore-https-errors',
  '--init-script',
  '--input-mode',
  '--json',
  '--max-output',
  '--model',
  '--namespace',
  '--no-auto-connect',
  '--no-auto-dialog',
  '--no-ca-cert',
  '--no-pin-tab',
  '--no-webmcp',
  '--offline',
  '--pin-tab',
  '--profile',
  '--provider',
  '--proxy',
  '--proxy-bypass',
  '--quick',
  '--quiet',
  '--relaunch',
  '--restore',
  '--restore-check-fn',
  '--restore-check-text',
  '--restore-check-url',
  '--restore-save',
  '--screenshot-dir',
  '--screenshot-format',
  '--screenshot-quality',
  '--session',
  '--session-name',
  '--state',
  '--use-system-ca',
  '--user-agent',
  '--verbose',
  '--webgpu',
  '-p',
  '-q',
  '-v'
])

const TAB_HINT = 'Use the typed tab commands (tab list, tab create, tab switch, tab close).'
const VIEWPORT_HINT = 'Use the typed viewport or set device command.'
const NOT_THE_PAGE = 'It acts outside the selected Orca page.'

// Commands that leave Orca's page: connect/tab/window/close retarget or create targets
// behind Orca's tab model, and the rest act on the machine or agent-browser itself.
const REFUSED_COMMANDS = new Map<string, string>([
  ['connect', NOT_THE_PAGE],
  ['tab', TAB_HINT],
  ['window', TAB_HINT],
  ['close', TAB_HINT],
  ['quit', TAB_HINT],
  ['exit', TAB_HINT],
  ['state', NOT_THE_PAGE],
  ['session', NOT_THE_PAGE],
  ['install', NOT_THE_PAGE],
  ['upgrade', NOT_THE_PAGE],
  ['doctor', NOT_THE_PAGE],
  ['dashboard', NOT_THE_PAGE],
  ['profiles', NOT_THE_PAGE],
  ['plugin', NOT_THE_PAGE],
  ['plugins', NOT_THE_PAGE],
  ['mcp', NOT_THE_PAGE],
  ['chat', NOT_THE_PAGE]
])

function refuse(what: string, hint: string): never {
  throw new BrowserError('invalid_argument', `exec does not run ${what}. ${hint}`)
}

/** Refuses raw agent-browser lines that would move the helper off Orca's selected page. */
export function assertAgentBrowserPassthroughStaysOnPage(args: readonly string[]): void {
  for (const arg of args) {
    const option = arg.split('=')[0]
    if (GLOBAL_OPTIONS.has(option)) {
      refuse(`agent-browser's global option ${option}`, 'Orca sets the browser and session.')
    }
  }
  const [command, subcommand] = args
  if (!command) {
    return
  }
  const refusal = REFUSED_COMMANDS.get(command)
  if (refusal) {
    refuse(`\`${command}\``, refusal)
  }
  // Both resize the real window around the page (Browser.setContentsSize).
  if (command === 'set' && (subcommand === 'viewport' || subcommand === 'device')) {
    refuse(`\`set ${subcommand}\``, VIEWPORT_HINT)
  }
  if (command === 'click' && args.includes('--new-tab')) {
    refuse('`click --new-tab`', TAB_HINT)
  }
  if (command === 'batch') {
    // agent-browser runs every operand except `--bail` as its own command line.
    for (const step of args.slice(1)) {
      if (step !== '--bail') {
        assertAgentBrowserPassthroughStaysOnPage(splitAgentBrowserCommandLine(step))
      }
    }
  }
}
