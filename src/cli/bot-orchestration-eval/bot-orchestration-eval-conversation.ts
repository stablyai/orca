// Runs one benchmark thread: the real agent CLI as a bot, each turn resuming the last, the way a bot's
// Chat continues; a turn can first queue mail, so it plays the turn a worker's report wakes, or change
// the host, as one that updates between turns.
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { BOT_FIRST_RUN_RULES, buildBotPreamble } from '../../main/bots/bot-preamble'
import { parseClaude, parseCodex } from './bot-orchestration-eval-agent-stream'
import { isBotCreatedKickoff } from '../../shared/bot-created-kickoff'
import type { ConnectorVerdict } from '../bot-automation-eval/bot-automation-eval-connector'
import {
  agentArgs,
  agentSessionFolder,
  childEnv,
  EVAL_BOT,
  evalFolder,
  type EvalAgent,
  type EvalHostState,
  type EvalWrite
} from '../bot-automation-eval/bot-automation-eval-host'
import {
  checkoutChanged,
  checkoutSnapshot,
  cloneCheckout,
  withCommitHistories
} from './bot-orchestration-eval-checkout'
import { queueMail, type SendVerdict, type StandInMessage } from './bot-orchestration-eval-mail'
import { closeFinishedWorkers, type WorkerStartVerdict } from './bot-orchestration-eval-workers'
import {
  evalTurnMessage,
  evalWorkRecord,
  evalWorkStorePath,
  seedEvalWork
} from './bot-orchestration-eval-work'

export type EvalTurn = {
  message: string
  /** Mail queued before this turn; a worker's report in it settles that worker. */
  mail?: StandInMessage[]
  /** Comes after finished workers' terminals closed on their own (the runtime's grace passed). */
  later?: true
  /** Merged over the host's state before this turn. */
  state?: Partial<EvalHostState>
}

/** A recorded write and, for a worker start or send, what the stand-in made of it. */
export type EvalRecordedWrite = EvalWrite & {
  result?: WorkerStartVerdict | SendVerdict | ConnectorVerdict | { suggested: true }
}

export type EvalTurnOutcome = {
  reply: string
  /** argv of every `orca` call. */
  commands: string[][]
  writes: EvalRecordedWrite[]
  /** Every shell command the agent ran, `orca` or not. */
  shell: string[]
  /** Every tool call, by name (`shell` for a command); a native read or MCP call shows here only. */
  tools: string[]
  /** The owner's own CLIs (gh, linear, ...) the bot reached for, by name. */
  ownerTools: string[]
  error?: string
  /** The turn ran out of time and was killed. */
  timedOut?: true
  /** What the turn cost, as Claude reports it; Codex reports none. */
  costUsd?: number
}

export type EvalThreadOutcome = {
  turns: EvalTurnOutcome[]
  /** Project checkouts whose HEAD, refs or files changed: work done in place, not in a workspace. */
  editedCheckouts: string[]
  transcript: string
}

function turnArgs(
  agent: EvalAgent,
  preamble: string,
  message: string,
  home: string,
  sessionId: string | undefined
): string[] {
  if (agent === 'claude') {
    const args = agentArgs(agent, preamble, message, home)
    const format = args.indexOf('json')
    args.splice(format, 1, 'stream-json', '--verbose')
    return sessionId ? [...args, '--resume', sessionId] : args
  }
  const args = agentArgs(agent, preamble, message, home).filter(
    (arg, index, all) =>
      arg !== '--output-last-message' && all[index - 1] !== '--output-last-message'
  )
  if (!sessionId) {
    return ['exec', '--json', ...args.slice(1)]
  }
  // `resume` takes no -C; the process runs in the home anyway.
  const flags = args
    .slice(1, -1)
    .filter((arg, index, all) => arg !== '-C' && all[index - 1] !== '-C')
  return ['exec', 'resume', '--json', ...flags, sessionId, message]
}

// A clean checkout of the real project makes a bot's look-around realistic; each thread reads its own
// clone of it. Without one the projects' folders don't exist and a bot can only hand off or ask.
const CHECKOUT_SOURCES: Record<string, string | undefined> = {
  orca: process.env.ORCA_BOT_EVAL_ORCA_CHECKOUT
}

const NOT_RUN = { reply: '', commands: [], writes: [], shell: [], tools: [], ownerTools: [] }

export async function runBotThread(input: {
  agent: EvalAgent
  standIn: string
  turns: EvalTurn[]
  state: Partial<EvalHostState>
  /** The bot's SOUL.md. */
  soul?: string
  /** The bot's MEMORY.md. */
  memory?: string
  /** A new bot's Chat: its turns carry the first-run rules until the owner's first turn. */
  firstRun?: true
  /** The bot's name, when the scenario turns on it (a bot created as "Automations"). */
  botName?: string
  timeoutMs: number
}): Promise<EvalThreadOutcome> {
  const botName = input.botName ?? EVAL_BOT.name
  // The automation benchmark's home prefix, so agentSessionFolder accepts it.
  const home = await realpath(await mkdtemp(join(tmpdir(), 'orca-bot-eval-home-')))
  try {
    await mkdir(evalFolder(home))
    await writeFile(join(home, 'SOUL.md'), input.soul ?? '')
    await writeFile(join(home, 'MEMORY.md'), input.memory ?? '')
    const repos = (input.state.repos ?? []).map((repo) =>
      isAbsolute(repo.path) ? repo : { ...repo, path: join(home, repo.path) }
    )
    const checkouts = repos.filter((repo) => CHECKOUT_SOURCES[repo.displayName])
    for (const repo of checkouts) {
      await cloneCheckout(CHECKOUT_SOURCES[repo.displayName]!, repo.path)
    }
    const before = await Promise.all(checkouts.map((repo) => checkoutSnapshot(repo.path)))
    const statePath = join(evalFolder(home), 'state.json')
    const merged: EvalHostState = {
      bots: [{ ...EVAL_BOT, agent: input.agent }],
      automations: [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...input.state,
      repos
    }
    // A scenario's own bots still run on this run's agent; this bot answers to its scenario's name.
    const state = {
      ...merged,
      bots: merged.bots.map((bot) => ({
        ...bot,
        agent: input.agent,
        ...(bot.id === EVAL_BOT.id ? { name: botName } : {})
      })),
      worktrees: await withCommitHistories(merged.worktrees, `${home}-ws`)
    }
    await writeFile(statePath, JSON.stringify(state))
    const readState = (): EvalHostState => JSON.parse(readFileSync(statePath, 'utf8'))
    const record = evalWorkRecord(readState, evalWorkStorePath(statePath))
    await seedEvalWork(record, state)
    const preamble = buildBotPreamble({
      name: botName,
      agent: input.agent,
      soul: input.soul ?? null,
      memory: input.memory ?? null
    })
    // As in the app: the rules ride each turn until the owner's first turn has run.
    let inFirstRun = input.firstRun === true
    const turns: EvalTurnOutcome[] = []
    const transcript: string[] = []
    let sessionId: string | undefined
    for (const turn of input.turns) {
      const current: EvalHostState = {
        ...JSON.parse(await readFile(statePath, 'utf8')),
        ...turn.state,
        woken: turn.mail ? true : undefined
      }
      // As the runtime keys them by the message a turn answers: a wake keeps the last turn's.
      if (!current.woken) {
        current.botRequests = []
      }
      if (turn.later) {
        closeFinishedWorkers(current)
      }
      queueMail(current, turn.mail ?? [])
      await writeFile(statePath, JSON.stringify(current))
      await writeFile(join(evalFolder(home), 'log.jsonl'), '')
      const words = await evalTurnMessage(record, readState(), turn.message).catch(
        (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
      )
      const message =
        inFirstRun && typeof words === 'string' ? `${BOT_FIRST_RUN_RULES}\n\n${words}` : words
      inFirstRun &&= isBotCreatedKickoff(turn.message)
      // A turn the harness couldn't build ends the thread as an infrastructure failure.
      if (message instanceof Error) {
        turns.push({ ...NOT_RUN, error: `harness: ${message.message}` })
        break
      }
      const result = await runProcess({
        program: input.agent,
        args: turnArgs(input.agent, preamble, message, home, sessionId),
        cwd: home,
        env: childEnv(input.standIn, home),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: input.timeoutMs
      })
      const parsed =
        input.agent === 'claude' ? parseClaude(result.stdout) : parseCodex(result.stdout)
      sessionId = parsed.sessionId ?? sessionId
      const log = (await readFile(join(evalFolder(home), 'log.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          (line): { kind: string; argv?: string[]; tool?: string } & Partial<EvalRecordedWrite> =>
            JSON.parse(line)
        )
      turns.push({
        reply: parsed.reply,
        commands: log.flatMap((entry) => (entry.argv ? [entry.argv] : [])),
        writes: log.flatMap((entry) =>
          entry.kind === 'write' && entry.method && entry.params
            ? [{ method: entry.method, params: entry.params, result: entry.result }]
            : []
        ),
        shell: parsed.shell,
        tools: parsed.tools,
        ownerTools: log.flatMap((entry) => (entry.tool ? [entry.tool] : [])),
        ...(result.code === 0
          ? {}
          : { error: `exit ${result.code}: ${result.stderr.slice(-300)}` }),
        ...(result.timedOut ? { timedOut: true as const } : {}),
        ...(parsed.costUsd === undefined ? {} : { costUsd: parsed.costUsd })
      })
      transcript.push(`>>> ${message}`, ...parsed.steps, `<<< ${parsed.reply}`, '')
    }
    record.dispose()
    const changed = await Promise.all(
      checkouts.map((repo, index) => checkoutChanged(repo.path, before[index]!))
    )
    return {
      turns,
      editedCheckouts: checkouts
        .filter((_, index) => changed[index])
        .map((repo) => repo.displayName),
      transcript: transcript.join('\n')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(`${home}-ws`, { recursive: true, force: true })
    await rm(evalFolder(home), { recursive: true, force: true })
    // Kept until here: every turn resumes the session stored in it.
    await rm(agentSessionFolder(home), { recursive: true, force: true })
  }
}
