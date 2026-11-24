// What a look-around run may do: read. Enforced where tools are called and where Orca's own
// commands are answered, never by asking the model. Anything not listed is refused.
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'

export const LOOK_AROUND_REFUSAL =
  'Looking around can only read. Suggest this as a next step instead.'

/** How a read-only session is held: a look reads through the allow-list below; a reply-only run
 *  (a tidy-up, whose inputs are all in its prompt) gets no tools, hooks or Orca commands at all. */
export type ReadOnlySessionMode = 'look-around' | 'reply-only'

export const REPLY_ONLY_REFUSAL = 'A tidy-up only replies: everything it needs is in its prompt.'

/** Read-only commands, by program then subcommand words; the subcommand must come first. */
const READ_COMMANDS: Record<string, readonly (readonly string[])[]> = {
  orca: [
    ['slack', 'find'],
    ['slack', 'read'],
    ['slack', 'check'],
    ['bot', 'connectors'],
    ['bot', 'list'],
    ['bot', 'chats'],
    ['bot', 'item', 'list'],
    ['bot', 'item', 'show'],
    ['bot', 'work', 'list'],
    ['linear', 'issue'],
    ['linear', 'search'],
    ['linear', 'list-issues'],
    ['bot', 'suggest'],
    ['automations', 'list'],
    ['automations', 'show'],
    ['repo', 'list'],
    ['worktree', 'ps'],
    ['worktree', 'list']
  ],
  gh: [
    ['pr', 'view'],
    ['pr', 'list'],
    ['pr', 'checks'],
    ['pr', 'diff'],
    ['issue', 'view'],
    ['issue', 'list'],
    ['run', 'view'],
    ['run', 'list']
  ],
  git: [['log'], ['show'], ['diff'], ['status'], ['branch'], ['rev-parse'], ['ls-files']]
}

/** Arguments that make an otherwise-read command write, run something, or send something. */
const REFUSED_ARGUMENTS: Record<string, (word: string) => boolean> = {
  // Joining a channel, saving a downloaded file, and showing a Connect card.
  orca: (word) => /^--(join|download|out|offer)/.test(word),
  // Bundled short flags (`-iXPOST`, `-if`) count: any single-dash word naming X, f or F.
  gh: (word) => /^--(method|input|field|raw-field)/.test(word) || /^-[^-]*[XfF]/.test(word),
  // Output files, external programs, and pathspec magic.
  git: (word) =>
    word.startsWith('-c') ||
    /^-[^-]*o/.test(word) ||
    /^--(output|exec|ext-diff|textconv|upload-pack|receive-pack)/.test(word) ||
    word.startsWith(':')
}

/** The only repo values gh may take: `owner/repo`, or `github.com/owner/repo`. */
const GITHUB_REPO = /^(?:github\.com\/)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
/** The only URLs gh may take. */
const GITHUB_URL = /^https:\/\/github\.com\//

/** gh reads only github.com, by allow-list: any other repo or URL is a host gh would contact. */
function ghStaysOnGitHub(args: readonly string[]): boolean {
  return args.every((word, index) => {
    const previous = args[index - 1]
    if (previous === '-R' || previous === '--repo') {
      return GITHUB_REPO.test(word)
    }
    if (word.startsWith('--repo=')) {
      return GITHUB_REPO.test(word.slice('--repo='.length))
    }
    // `--web`/`--web=<bool>` opens a browser on the owner's machine; `-Rhost/o/r` or a bundle hides a value.
    if (
      word === '--web' ||
      word.startsWith('--web=') ||
      (/^-[^-]*[Rw]/.test(word) && word !== '-R')
    ) {
      return false
    }
    return !word.includes('://') || GITHUB_URL.test(word)
  })
}

/** `git branch` only lists: with these, or none. */
const GIT_BRANCH_LISTING: ReadonlySet<string> = new Set(['-a', '-r', '--all', '--remotes'])

/** The shell a command runs in: Bash (or Codex's sh wrapper), or Claude's PowerShell tool on Windows. */
export type LookAroundShell = 'bash' | 'powershell'

/** A shell can read nothing else into these: no globs, braces, tildes, history or expansion. */
const PLAIN_WORD = /^[A-Za-z0-9._/:=@,+-]+$/

/** PowerShell reads curly quotes as quotes and these dashes as `-`, so a quoted value could close
 *  early; refused in both shells, since a command string may reach either. */
const CURLY_QUOTE_OR_DASH = /[\u2013-\u201E]/

type Word = { text: string; quoted: boolean }

/**
 * Splits a command into words: plain words, or single-quoted text with no quote inside. Null for
 * anything else, so no shell syntax (piping, redirection, expansion, globs) reaches the checks.
 */
function words(command: string): Word[] | null {
  const out: Word[] = []
  let consumed = ''
  for (const match of command.matchAll(/(?<=^|[ \t])(?:'([^'\n\r]*)'|([^\s']+))(?=[ \t]|$)/g)) {
    const [whole, quoted, plain] = match
    if (plain !== undefined && (!PLAIN_WORD.test(plain) || plain.startsWith('='))) {
      return null
    }
    out.push(
      quoted === undefined ? { text: plain ?? '', quoted: false } : { text: quoted, quoted: true }
    )
    consumed += whole
  }
  // Anything a word didn't take (a stray quote, a newline) is syntax this check can't read.
  const gaps = (text: string) => text.replace(/[ \t]/g, '')
  return gaps(consumed) === gaps(command) ? out : null
}

/**
 * Splits a command at `;`, `&&` and `||` outside single quotes. Where this misreads the shell's
 * quoting, a part keeps a stray quote and `words` refuses it.
 */
function chainParts(command: string): string[] {
  const parts: string[] = []
  let start = 0
  let quoted = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "'") {
      quoted = !quoted
    } else if (!quoted && (char === ';' || ('&|'.includes(char) && command[index + 1] === char))) {
      parts.push(command.slice(start, index).trim())
      index += char === ';' ? 0 : 1
      start = index + 1
    }
  }
  parts.push(command.slice(start).trim())
  return parts
}

/** The one redirect a read may end with: stderr into the output, or (Bash) away. */
const TRAILING_REDIRECT: Record<LookAroundShell, RegExp> = {
  bash: /[ \t]+2>(?:&1|\/dev\/null)$/,
  powershell: /[ \t]+2>&1$/
}

/** Codex wraps commands as `/bin/zsh -lc '<command>'`; the inner command is what runs. */
export function unwrapShell(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+'((?:[^']|'\\'')*)'$/.exec(command.trim())
  return wrapped ? wrapped[1].replace(/'\\''/g, "'") : command.trim()
}

/** How a bot's preamble names this session's own CLI on POSIX; Orca seals the variable. */
const BOT_CLI_PREFIX = '"${ORCA_CLI_COMMAND:-orca}" '

/** Shell syntax a look-around command may not use, named for the refusal, with the matched text or not. */
const SHELL_SYNTAX: readonly (readonly [RegExp, string, boolean])[] = [
  [/\n|\r/, 'a second line', false],
  [/"/, "double quotes (use 'single quotes')", false],
  [/\|/, 'a pipe', true],
  [/\d*(?:>>?|<)(?:&\d*-?)?/, 'a redirect', true],
  [/&/, 'running in the background', true],
  [/\$\(?|`/, 'expansion', true]
]

function syntaxRefusal(what: string): string {
  return `Looking around runs plain reads, chained only with ;, && or || and ending at most in 2>&1: ${what} isn't allowed. Use plain words or 'single quotes'.`
}

/** Names the shell syntax that kept `command` from splitting into plain words. */
function shellSyntaxRefusal(command: string): string {
  const unquoted = command.replace(/'[^'\n\r]*'/g, "''")
  for (const [pattern, name, show] of SHELL_SYNTAX) {
    const match = pattern.exec(unquoted)
    if (match) {
      return syntaxRefusal(show ? `${name} ("${match[0]}")` : name)
    }
  }
  const word = unquoted.split(/[ \t]+/).find((part) => part && !PLAIN_WORD.test(part))
  return syntaxRefusal(`"${word ?? command}"`)
}

/** Words PowerShell would pass differently from how they read: splatting, arrays, and values
 *  Windows PowerShell 5.1 re-quotes into other arguments. */
function powerShellWordRefusal(parts: readonly Word[]): string | null {
  for (const { text, quoted } of parts) {
    if (quoted && text.includes('"')) {
      return syntaxRefusal("a double quote inside 'single quotes' in PowerShell")
    }
    if (quoted && (text === '' || text.endsWith('\\'))) {
      return syntaxRefusal(`'${text}' (empty or ending in \\) in PowerShell`)
    }
    if (!quoted && text.startsWith('@')) {
      return syntaxRefusal(`"${text}" (splatting in PowerShell)`)
    }
    if (!quoted && text.includes(',')) {
      return syntaxRefusal(`"${text}" (an array in PowerShell; quote it)`)
    }
  }
  return null
}

function notARead(what: string): string {
  return `Looking around can only read: ${what}. Suggest this as a next step instead.`
}

/** Why one part of a chain is not a read the run may make, or null when it is. */
function partRefusal(part: string, shell: LookAroundShell): string | null {
  const read = part.replace(TRAILING_REDIRECT[shell], '')
  const inner =
    shell === 'bash' && read.startsWith(BOT_CLI_PREFIX)
      ? `orca ${read.slice(BOT_CLI_PREFIX.length)}`
      : read
  const parsed = words(inner)
  if (!parsed) {
    return shellSyntaxRefusal(inner)
  }
  const powerShellRefusal = shell === 'powershell' ? powerShellWordRefusal(parsed) : null
  if (powerShellRefusal !== null) {
    return powerShellRefusal
  }
  if (parsed.length === 0) {
    return notARead('an empty command runs nothing')
  }
  const [program, ...rest] = parsed.map((word) => word.text)
  // A bare name, so PATH picks the real program, not `./gh` or `node_modules/.bin/git`; an
  // environment assignment (`FOO=1 gh`) is no name at all.
  const allowed = Object.hasOwn(READ_COMMANDS, program) ? READ_COMMANDS[program] : undefined
  const path = allowed?.find((candidate) => candidate.every((word, index) => rest[index] === word))
  if (!path) {
    const end = rest.findIndex((word) => !/^[a-z][a-z-]*$/.test(word))
    const subcommand = rest.slice(0, Math.min(3, end === -1 ? 3 : end))
    return notARead(`"${[program, ...subcommand].join(' ')}" isn't a read`)
  }
  const name = [program, ...path].join(' ')
  const args = rest.slice(path.length)
  const refused = args.find((word) => REFUSED_ARGUMENTS[program]?.(word) === true)
  if (refused !== undefined) {
    return notARead(`"${refused}" makes "${name}" more than a read`)
  }
  if (program === 'gh' && !ghStaysOnGitHub(args)) {
    return notARead(`"${name}" may only read github.com, without --web`)
  }
  if (path[0] === 'branch' && !args.every((word) => GIT_BRANCH_LISTING.has(word))) {
    return notARead('"git branch" may only list branches')
  }
  return null
}

/** Why a shell command is not reads the run may make, or null when it is: each part of a chain is
 *  held to the same rules, and one refused part refuses the whole command. */
export function lookAroundCommandRefusal(
  command: string,
  shell: LookAroundShell = 'bash'
): string | null {
  const unwrapped = shell === 'bash' ? unwrapShell(command) : command.trim()
  const curly = CURLY_QUOTE_OR_DASH.exec(unwrapped)
  if (curly) {
    return syntaxRefusal(`a curly quote or dash ("${curly[0]}"; use straight ' and -)`)
  }
  const parts = chainParts(unwrapped)
  for (const part of parts) {
    const refusal = partRefusal(part, shell)
    if (refusal !== null) {
      return parts.length > 1 ? `${refusal} Refused part: ${part || '(empty)'}` : refusal
    }
  }
  return null
}

/** Whether a shell command is reads the run may make. */
export function lookAroundCommandAllowed(
  command: string,
  shell: LookAroundShell = 'bash'
): boolean {
  return lookAroundCommandRefusal(command, shell) === null
}

/** Claude tools that only read, or only look up other tools. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'TodoWrite',
  'ToolSearch'
])

/** Claude's shell tools; PowerShell is Claude Code's shell on Windows. */
const SHELL_TOOLS: ReadonlyMap<string, LookAroundShell> = new Map([
  ['Bash', 'bash'],
  ['PowerShell', 'powershell']
])

export type LookAroundToolDecision = { decision: 'allow' } | { decision: 'deny'; reason: string }

/** Claude's PreToolUse answer: an explicit allow, so a read never waits on a prompt nobody sees;
 *  a refusal names what was refused, so the model doesn't retry variants of it. */
export function lookAroundToolDecision(toolName: string, input: unknown): LookAroundToolDecision {
  if (READ_TOOLS.has(toolName)) {
    return { decision: 'allow' }
  }
  const shell = SHELL_TOOLS.get(toolName)
  if (shell && typeof input === 'object' && input !== null && 'command' in input) {
    const refusal =
      typeof input.command === 'string'
        ? lookAroundCommandRefusal(input.command, shell)
        : notARead('the command is missing')
    return refusal === null ? { decision: 'allow' } : { decision: 'deny', reason: refusal }
  }
  // MCP tools, writes, web fetches, subagents and anything new.
  return {
    decision: 'deny',
    reason: `Looking around can only read: the ${toolName} tool isn't allowed. Reads run through Read, Grep, Glob, Bash or PowerShell; suggest anything else as a next step instead.`
  }
}

/** A second guard for Claude: tools the CLI never offers this run. */
export const LOOK_AROUND_DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent'
] as const

/** connector.act from a look-around run: only reads, never joining a channel or downloading a file. */
export function lookAroundConnectorVerbAllowed(verb: string, args: ConnectorActionArgs): boolean {
  if (verb === 'check') {
    return args.join !== true
  }
  if (verb === 'read') {
    return args.download === undefined
  }
  return verb === 'find' || verb === 'capabilities' || verb === 'places'
}

/** Orchestration methods a look-around run may call: the ones that only read. */
const READ_ORCHESTRATION_METHODS: ReadonlySet<string> = new Set([
  'orchestration.runList',
  'orchestration.runShow',
  'orchestration.runCurrent',
  'orchestration.taskList',
  'orchestration.workerList',
  'orchestration.workerShow',
  'orchestration.dispatchShow',
  'orchestration.gateList',
  'orchestration.callerShow',
  'orchestration.sessionAddress',
  'orchestration.partyLocation',
  'orchestration.check'
])

export function lookAroundOrchestrationAllowed(method: string): boolean {
  return READ_ORCHESTRATION_METHODS.has(method)
}
