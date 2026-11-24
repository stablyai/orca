import type { LeaveThreadRefusalCode } from '../../shared/connectors/connector-leave-thread-copy'
// Runs one benchmark turn: the real agent CLI as a bot, in a scratch home, with the stand-in `orca`.
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { LinearRun } from './bot-automation-eval-linear'
import type { BotWorkPullRequest } from '../../shared/bots/bot-work-pull-request'
import { buildBotPreamble } from '../../main/bots/bot-preamble'
import { writeOwnerToolShims } from './bot-automation-eval-owner-tools'
import type { StandInMessage } from '../bot-orchestration-eval/bot-orchestration-eval-mail'
import type { StandInWorker } from '../bot-orchestration-eval/bot-orchestration-eval-workers'
import type { EvalGithub } from './bot-automation-eval-gh'
import type { BotLookState } from '../../main/bots/bot-look-around-state'

export type EvalAgent = 'claude' | 'codex'

export type EvalHostState = {
  bots: (Pick<
    Bot,
    'id' | 'name' | 'agent' | 'slack' | 'slackApps' | 'github' | 'linear' | 'linearWorkspaces'
  > &
    Partial<Pick<Bot, 'paused' | 'members'>>)[]
  automations: Automation[]
  /** Whether the host's Orca Cloud takes webhooks, as bots.list says. */
  webhooks?: boolean
  /** What `orca slack find` and automations' place lookups match: Slack channels, Linear teams and issues, GitHub repos. */
  places?: {
    ref: string
    label: string
    /** What `orca slack read` returns there; a Linear issue in `linear` reads as its description. */
    messages?: {
      author: string
      text: string
      /** Files on the message; a download answers with `content`. */
      files?: { id: string; name: string; type: string; content: string }[]
    }[]
  }[]
  /** What the bot's sets and creates did to the shared Linear world. */
  linearRun?: LinearRun
  repos: { id: string; displayName: string; path: string }[]
  timezone: string
  /** Orchestration stand-in state (see bot-orchestration-eval); shaped like the runtime's replies. */
  worktrees?: Record<string, unknown>[]
  /** What `orca terminal read` shows for an agent's terminal, by handle. */
  terminalTranscripts?: Record<string, string>
  workers?: StandInWorker[]
  /** Unread mail for the bot's run, what it already read, and what it sent. */
  mail?: StandInMessage[]
  read?: StandInMessage[]
  sent?: StandInMessage[]
  /** A host where every worker start fails at this stage, with this error. */
  startFailure?: { stage: string; error: string }
  /** A host where a worker stop closes the terminal but cannot prove the agent exited. */
  stopUnconfirmed?: boolean
  /** The connector conversation a thread is (a Slack thread, a Linear issue); absent, the owner's
   *  own Chat, where Orca keeps no work record. */
  conversation?: {
    source: 'slack' | 'linear' | 'github'
    title: string
    /** The issue key, or owner/repo#N, that woke it, when not a Slack thread. */
    placeId?: string
    /** The Slack person whose message the thread answers; the owner when absent. */
    asker?: string
    /** Their name, as Orca Cloud stamps it. */
    askerName?: string
    /** Its Slack channel and thread (the channel, for a DM); the Slack world's #exports thread when
     *  absent. */
    slack?: { channel: string; thread: string }
    /** Slack's grant to search as the asker never reached the turn, so search refuses (no_asker). */
    noSearchGrant?: true
  }
  /** The owner's own Slack CLI (agent-slack) is on the host and reads as them. */
  ownerSlack?: true
  /** `bot reply --leave-thread` is refused with this, as the host would refuse it. */
  leaveRefusal?: LeaveThreadRefusalCode
  /** The bot already left its thread this turn. */
  leftThread?: true
  /** This turn is a wake (a worker's mail or pull request events), which answers no one's message. */
  woken?: true
  /** Work the bot started before the run, by the conversation it came from. */
  recorded?: {
    dispatchId: string
    source: 'slack' | 'linear' | 'github'
    externalId: string
    title: string
  }[]
  /** A worker workspace's pull request, by worktree id, as GitHub would answer. */
  pulls?: Record<string, BotWorkPullRequest>
  /** Each bot's SOUL.md, by bot id, for what `bot list` says it is for. */
  souls?: Record<string, string>
  /** The bot request this turn was woken by: its hop and whom Orca recorded it for, which the turn inherits. */
  actingOnRequest?: { depth: number; askers: BotRequestAsker[] }
  /** The bot requests the bot sent in this request (bot-orchestration-eval-bots). */
  botRequests?: { toBotId: string; purpose: string; message: StandInMessage }[]
  /** Slack channels the bot's app is not in, so a post there is refused. */
  notInChannels?: string[]
  /** Whether Orca publishing is on (`artifacts share` gives a link) or off (refused); absent, the
   *  host answers neither. */
  artifactSharing?: 'on' | 'off'
  /** The answer surface refuses files, so no attachment posts. */
  filesRefused?: true
  /** The bot's open items, by number, that `bot item comment` reaches. */
  items?: { number: number; title: string }[]
  /** The GitHub repository each project tracks, by project id. */
  githubRepos?: Record<string, { id: number; fullName: string }>
  /** The owner's `gh` (signed in unless `signedOut`), and whether `orca linear` has no login or key. */
  github?: EvalGithub
  linearSignedOut?: true
  /** A recurring look; suggestions use the real look-around state transitions. */
  lookAround?: BotLookState
}

/** A recorded write; `result` is what the stand-in made of it, when that matters to grading. */
export type EvalWrite = { method: string; params: Record<string, unknown>; result?: unknown }

export type EvalOutcome = {
  writes: EvalWrite[]
  commands: string[][]
  /** The owner's own CLIs (gh, linear, ...) the bot reached for, by name. */
  ownerTools: string[]
  reply: string
  error?: string
}

// Every connector set up, so only a scenario that removes one meets a missing connector.
export const EVAL_BOT = {
  id: 'bot-ranger',
  name: 'Ranger',
  slack: { appId: 'A0EVAL', teamId: 'T0EVAL' },
  github: {},
  linear: { workspaceId: 'lin-eval', workspaceName: 'Eval' }
}

const HOME_PREFIX = 'orca-bot-eval-home-'

/** The stand-in's state, log and reply for a home: beside it, where the bot doesn't look. */
export function evalFolder(home: string): string {
  return `${home}-eval`
}

/** The transcript folder Claude Code keeps per working folder, so each run removes its own. */
export function agentSessionFolder(home: string): string {
  const name = home.replace(/[^A-Za-z0-9]/g, '-')
  // Never anything but a bot home's folder, whatever `home` is.
  if (!name.includes(`-${HOME_PREFIX.replace(/-$/, '')}-`)) {
    throw new Error(`not a benchmark home: ${home}`)
  }
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', name)
}

// Agents run commands in a login shell. Only zsh reads the profile below; bash's reads the owner's
// own, which puts the real orca, gh and gcloud ahead of the shims.
function assertZshLoginShell(): void {
  const shells = [process.env.SHELL, userInfo().shell]
  if (!shells.every((shell) => shell?.endsWith('/zsh'))) {
    throw new Error(
      `The bot automation eval needs zsh as the login shell (SHELL and the account's shell), not ${shells.join(', ')}.`
    )
  }
}

/** Bundles the stand-in once; `bin/orca` runs it. */
export async function prepareStandIn(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  assertZshLoginShell()
  const dir = await mkdtemp(join(tmpdir(), 'orca-bot-eval-cli-'))
  await build({
    entryPoints: {
      orca: join(__dirname, 'bot-automation-eval-orca.ts'),
      'owner-slack': join(__dirname, 'bot-automation-eval-owner-slack.ts'),
      gh: join(__dirname, 'bot-automation-eval-gh-cli.ts')
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir: dir,
    outExtension: { '.js': '.cjs' },
    logLevel: 'warning',
    external: ['electron']
  })
  await mkdir(join(dir, 'bin'))
  const bin = join(dir, 'bin', 'orca')
  await writeFile(bin, `#!/bin/sh\nexec node "${join(dir, 'orca.cjs')}" "$@"\n`)
  await chmod(bin, 0o755)
  // A login shell's profile puts the owner's tools back ahead of the shims; this one re-prepends them.
  await mkdir(join(dir, 'zdot'))
  for (const file of ['.zshenv', '.zprofile', '.zshrc']) {
    await writeFile(join(dir, 'zdot', file), `export PATH="${join(dir, 'bin')}:$PATH"\n`)
  }
  await writeOwnerToolShims(dir)
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}

// The parent may be an Orca agent: its pane and hook variables would reach the live app.
export function childEnv(standIn: string, home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/^(ORCA_|CLAUDECODE$|CLAUDE_CODE_|CODEX_THREAD|VITEST|GIT_CONFIG|GH_|GITHUB_)/.test(key)
    ) {
      env[key] = value
    }
  }
  return {
    ...env,
    PATH: `${join(standIn, 'bin')}${delimiter}${env.PATH ?? ''}`,
    ZDOTDIR: join(standIn, 'zdot'),
    ORCA_CLI_COMMAND: join(standIn, 'bin', 'orca'),
    ORCA_EVAL_STATE: join(evalFolder(home), 'state.json'),
    ORCA_EVAL_LOG: join(evalFolder(home), 'log.jsonl'),
    // A real gh reached past the stand-in (by absolute path) finds no login of the owner's.
    GH_CONFIG_DIR: join(evalFolder(home), 'no-gh'),
    // `orca status` reads the app's metadata directly, past the stand-in; point it at nothing.
    ORCA_USER_DATA_PATH: join(evalFolder(home), 'no-orca'),
    // A bot is a native chat; without these, chat-only commands refuse before the stand-in.
    ORCA_AGENT_SESSION_ID: randomUUID(),
    ORCA_STRUCTURED_SESSION: '1',
    // No real publication: Claude's Artifact tool would post to the owner's account.
    CLAUDE_CODE_DISABLE_ARTIFACT: '1',
    // Blocks accidental and casual network use by git, however git is invoked (an absolute path, an
    // alias, `-c` or repo-local config): only local-file transports, and no system or global config,
    // so no credential helper. Deliberate evasion (curl with a token from the keychain or gh's hosts
    // file) needs an OS sandbox, which is out of scope.
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Bot eval',
    GIT_AUTHOR_EMAIL: 'bot-eval@example.invalid',
    GIT_COMMITTER_NAME: 'Bot eval',
    GIT_COMMITTER_EMAIL: 'bot-eval@example.invalid',
    GIT_SSH_COMMAND: 'false',
    GIT_TERMINAL_PROMPT: '0',
    SSH_AUTH_SOCK: ''
  }
}

// Pinned for a comparable run; absent, the agent CLI's own default (which the report names).
const MODEL = process.env.ORCA_BOT_EVAL_MODEL

export function agentArgs(agent: EvalAgent, preamble: string, message: string, home: string) {
  return agent === 'claude'
    ? [
        ...(MODEL ? ['--model', MODEL] : []),
        '-p',
        message,
        '--append-system-prompt',
        preamble,
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        // Same reason as the tool shims: the owner's skills and servers reach real services.
        '--disallowedTools',
        'Skill',
        '--strict-mcp-config'
      ]
    : [
        'exec',
        ...(MODEL ? ['-m', MODEL] : []),
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        home,
        '-c',
        `developer_instructions=${JSON.stringify(preamble)}`,
        // Same reason as the tool shims; plugins include ones that drive the screen.
        '-c',
        'mcp_servers={}',
        '-c',
        'features.plugins=false',
        '--output-last-message',
        join(evalFolder(home), 'reply.txt'),
        message
      ]
}

async function readReply(agent: EvalAgent, home: string, stdout: string): Promise<string> {
  if (agent === 'codex') {
    return readFile(join(evalFolder(home), 'reply.txt'), 'utf8').catch(() => '')
  }
  try {
    const parsed: unknown = JSON.parse(stdout)
    return parsed && typeof parsed === 'object' && 'result' in parsed
      ? String(parsed.result)
      : stdout
  } catch {
    return stdout
  }
}

export async function runBotTurn(input: {
  agent: EvalAgent
  standIn: string
  message: string
  automations: Automation[]
  timeoutMs: number
  /** Merged over the default state. */
  state?: Partial<EvalHostState>
  /** The bot's MEMORY.md, as a chat loads it. */
  memory?: string
}): Promise<EvalOutcome> {
  const home = await realpath(await mkdtemp(join(tmpdir(), HOME_PREFIX)))
  try {
    await mkdir(evalFolder(home))
    await writeFile(join(home, 'SOUL.md'), '')
    await writeFile(join(home, 'MEMORY.md'), input.memory ?? '')
    const merged: EvalHostState = {
      bots: [{ ...EVAL_BOT, agent: input.agent }],
      automations: input.automations,
      repos: [{ id: 'repo-orca', displayName: 'orca', path: join(home, 'orca') }],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...input.state
    }
    // A scenario's own bots still run on this run's agent.
    const state = {
      ...merged,
      bots: merged.bots.map((bot) => ({ ...bot, agent: input.agent }))
    }
    await writeFile(join(evalFolder(home), 'state.json'), JSON.stringify(state))
    await writeFile(join(evalFolder(home), 'log.jsonl'), '')
    const preamble = buildBotPreamble({
      name: EVAL_BOT.name,
      agent: input.agent,
      soul: null,
      memory: input.memory ?? null
    })
    const result = await runProcess({
      program: input.agent,
      args: agentArgs(input.agent, preamble, input.message, home),
      cwd: home,
      env: childEnv(input.standIn, home),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: input.timeoutMs
    })
    const log = (await readFile(join(evalFolder(home), 'log.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line): { kind: string; argv?: string[]; tool?: string } & Partial<EvalWrite> =>
        JSON.parse(line)
      )
    return {
      writes: log.flatMap((entry) =>
        entry.kind === 'write' && entry.method && entry.params
          ? [{ method: entry.method, params: entry.params, result: entry.result }]
          : []
      ),
      commands: log.flatMap((entry) => (entry.argv ? [entry.argv] : [])),
      ownerTools: log.flatMap((entry) => (entry.tool ? [entry.tool] : [])),
      reply: await readReply(input.agent, home, result.stdout),
      ...(result.code === 0 ? {} : { error: `exit ${result.code}: ${result.stderr.slice(-500)}` })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(evalFolder(home), { recursive: true, force: true })
    await rm(agentSessionFolder(home), { recursive: true, force: true })
  }
}
