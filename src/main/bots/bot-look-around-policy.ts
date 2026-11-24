// What a look-around run may do: read. Enforced where tools are called and where Orca's own
// commands are answered, never by asking the model. Anything not listed is refused.
import type { ConnectorActionArgs } from '../../shared/connector-action-contract'
import {
  BOT_CLI_PREFIX,
  chainParts,
  characterRefusal,
  type LookAroundShell,
  powerShellWordRefusal,
  shellSyntaxRefusal,
  TRAILING_REDIRECT,
  trimBlanks,
  unwrapShell,
  words
} from './bot-look-around-shell-syntax'

export type { LookAroundShell } from './bot-look-around-shell-syntax'

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
  const unwrapped = shell === 'bash' ? unwrapShell(command) : trimBlanks(command)
  const characters = characterRefusal(unwrapped)
  if (characters !== null) {
    return characters
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

/** The shells a Codex command may run in here: on Windows that is PowerShell, or Bash under WSL
 *  or Git Bash, so a command must pass both. */
export function codexCommandShells(
  platform: NodeJS.Platform = process.platform
): readonly LookAroundShell[] {
  return platform === 'win32' ? ['powershell', 'bash'] : ['bash']
}

/** The one answer to a shell command, for Claude's shell tools and Codex's approvals alike: it
 *  must be reads in every shell it may run in. */
export function lookAroundShellDecision(
  command: unknown,
  shells: readonly LookAroundShell[]
): LookAroundToolDecision {
  for (const shell of shells) {
    const refusal =
      typeof command === 'string'
        ? lookAroundCommandRefusal(command, shell)
        : notARead('the command is missing')
    if (refusal !== null) {
      return { decision: 'deny', reason: refusal }
    }
  }
  return { decision: 'allow' }
}

/** Claude's PreToolUse answer: an explicit allow, so a read never waits on a prompt nobody sees;
 *  a refusal names what was refused, so the model doesn't retry variants of it. */
export function lookAroundToolDecision(toolName: string, input: unknown): LookAroundToolDecision {
  if (READ_TOOLS.has(toolName)) {
    return { decision: 'allow' }
  }
  const shell = SHELL_TOOLS.get(toolName)
  if (shell && typeof input === 'object' && input !== null && 'command' in input) {
    return lookAroundShellDecision(input.command, [shell])
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
