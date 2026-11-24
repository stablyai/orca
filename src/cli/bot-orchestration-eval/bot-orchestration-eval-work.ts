// The stand-in host's work record: Orca's own BotWorkRecord over a store file beside the stand-in's
// state, reading workers and workspaces from that state. The `orca` stand-in records starts and
// answers `bot work`; the thread runner reads the turn note.
import { join } from 'node:path'
import { BotWorkRecord, type BotTurnAddress } from '../../main/bots/bot-work-record'
import { BotWorkStore } from '../../main/bots/bot-work-store'
import { inProcessBotWork } from '../../main/bots/bot-work-ops'
import type { BotWorkListResult } from '../../shared/bots/bot-work-list'
import type { BotWorkWorker } from '../../main/bots/bot-work-types'
import type { OrchestrationSessionWorkerState } from '../../shared/orchestration-session-workers'
import type { EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import type { StandInWorker } from './bot-orchestration-eval-workers'

const STATES: Record<StandInWorker['state'], OrchestrationSessionWorkerState> = {
  ready: 'working',
  succeeded: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  stop_unknown: 'unverifiable'
}

// Workers started before the run (fixtures) and during it all read as started an hour ago.
const STARTED_AT = Date.now() - 60 * 60_000

/** The one conversation a scenario's thread is, when it is a connector's (a Slack thread, an issue). */
export function evalTurnAddress(state: EvalHostState): BotTurnAddress | null {
  const bot = state.bots[0]
  return state.conversation && bot
    ? { botId: bot.id, address: { source: state.conversation.source, externalId: 'eval-thread' } }
    : null
}

/** The work record's file for a stand-in state file. */
export function evalWorkStorePath(statePath: string): string {
  return join(statePath, '..', 'work.sqlite')
}

/** The newest Dispatch of a worker's lineage, as orchestration reads it. */
function latest(state: EvalHostState, dispatchId: string): StandInWorker | undefined {
  const worker = (state.workers ?? []).find((entry) => entry.dispatchId === dispatchId)
  const next = worker && (state.workers ?? []).find((entry) => entry.followUpOf === dispatchId)
  return next ? latest(state, next.dispatchId) : worker
}

/** A Dispatch's worker as the work record reads it. */
function evalWorker(state: EvalHostState, dispatchId: string): BotWorkWorker | null {
  const worker = latest(state, dispatchId)
  if (!worker) {
    return null
  }
  return {
    dispatchId: worker.dispatchId,
    taskId: worker.taskId,
    title: String(worker.spec ?? worker.taskId).split('\n')[0]!,
    agent: typeof worker.agent === 'string' ? worker.agent : null,
    state: STATES[worker.state],
    stopped: worker.state === 'stopped',
    // The stand-in's failed starts never ran an agent.
    startFailed: worker.state === 'failed' && !worker.worktreeId,
    host: worker.server ?? 'local',
    hostName: worker.server ?? null,
    worktreeId: worker.worktreeId || null,
    startedAt: STARTED_AT,
    settledAt: worker.state === 'ready' ? null : STARTED_AT
  }
}

/** Orca's own work record, reading the stand-in's state as it is on each call; `dispose` releases
 *  its store file. */
export function evalWorkRecord(
  read: () => EvalHostState,
  storePath: string
): BotWorkRecord & { dispose: () => void } {
  let store: BotWorkStore | undefined
  const remote = inProcessBotWork(() => (store ??= BotWorkStore.open(storePath)))
  const record = new BotWorkRecord({
    store: () => remote,
    workers: async (dispatchIds) =>
      new Map(dispatchIds.map((dispatchId) => [dispatchId, evalWorker(read(), dispatchId)])),
    workspaces: () => async (worker) => {
      const state = read()
      if (!worker.worktreeId || worker.host !== 'local') {
        return null
      }
      const row = (state.worktrees ?? []).find((entry) => entry.worktreeId === worker.worktreeId)
      // Removed from the stand-in's list is the stand-in's proof the workspace is gone.
      if (!row) {
        return 'gone'
      }
      const branch = String(row.branch ?? '').replace(/^refs\/heads\//, '')
      const pull = state.pulls?.[worker.worktreeId] ?? null
      return {
        name: String(row.displayName ?? branch),
        branch: branch || null,
        head: pull?.headSha ?? `${branch}-head`,
        pullRequest: pull
      }
    },
    conversationTitle: (address) =>
      read().recorded?.find((seed) => seed.externalId === address.externalId)?.title ??
      read().conversation?.title ??
      null,
    turnAddress: async () => evalTurnAddress(read())
  })
  return Object.assign(record, { dispose: () => store?.dispose() })
}

/** A worker the bot's turn started joins the conversation's record, as the runtime's start does. */
export async function recordEvalWorkerStart(
  record: BotWorkRecord,
  state: EvalHostState,
  receipt: unknown
): Promise<void> {
  const turn = evalTurnAddress(state)
  const started = typeof receipt === 'object' && receipt !== null ? receipt : {}
  if (
    turn &&
    'state' in started &&
    started.state === 'ready' &&
    'taskId' in started &&
    'dispatchId' in started
  ) {
    const worker = latest(state, String(started.dispatchId))
    await record.started(turn, {
      taskId: String(started.taskId),
      dispatchId: String(started.dispatchId),
      host: worker?.server ?? 'local'
    })
  }
}

/** `orca bot work list`, as the runtime's bots.work.list answers it. */
export async function listEvalWork(
  record: BotWorkRecord,
  state: EvalHostState
): Promise<BotWorkListResult> {
  const bot = state.bots[0]
  return { items: await record.list(bot?.id ?? ''), botName: bot?.name ?? '' }
}

/** `orca bot work list|forget`, answered as the runtime's bots.work methods do; undefined for
 *  any other method. */
export async function serveEvalWork(
  record: BotWorkRecord,
  state: EvalHostState,
  method: string
): Promise<unknown> {
  switch (method) {
    case 'bots.work.list':
      return await listEvalWork(record, state)
    case 'bots.work.forget':
      // The runtime knows the turn's conversation from its handover; the stand-in's is its thread.
      await record.turnNote(EVAL_SESSION, { origin: 'connector' })
      return { forgotten: await record.forget(EVAL_SESSION) }
  }
  return undefined
}

/** The bot conversation's session, as the record names it. */
export const EVAL_SESSION = 'eval-session'

/** Work the bot started before the run, recorded as its turns would have. */
export async function seedEvalWork(record: BotWorkRecord, state: EvalHostState): Promise<void> {
  const botId = state.bots[0]?.id ?? ''
  for (const seed of state.recorded ?? []) {
    const worker = latest(state, seed.dispatchId)
    await record.started(
      { botId, address: { source: seed.source, externalId: seed.externalId } },
      {
        taskId: worker?.taskId ?? seed.dispatchId,
        dispatchId: seed.dispatchId,
        host: worker?.server ?? 'local'
      }
    )
  }
}

/** What the bot reads for a turn, as the runtime hands it over: the conversation's work note ahead
 *  of the words. */
export async function evalTurnMessage(
  record: BotWorkRecord,
  state: EvalHostState,
  message: string
): Promise<string> {
  const words = message
  const note = evalTurnAddress(state)
    ? await record.turnNote(EVAL_SESSION, { origin: 'connector' })
    : null
  return note ? `${note}\n\n${words}` : words
}
