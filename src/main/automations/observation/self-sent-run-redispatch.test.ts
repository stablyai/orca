import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
import type { Store } from '../../persistence/loading-store/store'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { makeTestBot } from '../../bots/bot.test-fixture'
import { runtimeBotGroups } from '../../bots/bot-group-runtime'
import { AutomationService } from '../automation-service'
import type { AutomationBotLauncher } from '../launch/automation-launch'
import { automationRunOperationId } from '../launch/automation-run-operation'
import { recoverSelfSentRun } from './self-sent-run-restart-recovery'
import { yieldToEventLoop } from '../../../shared/concurrency/event-loop-yield'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))

// Orca quit after a self-sent run claimed its dispatch but before its prompt reached its agent. When
// nothing holds the prompt, the next start hands the run to its own launch, which alone settles it; a
// room post that holds the prompt keeps the run from ever being sent again.
const NOW = Date.parse('2026-11-27T12:00:00Z')
let orchestration: OrchestrationDb
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-self-sent-redispatch-'))
  orchestration = new OrchestrationDb(join(testState.dir, 'orchestration.db'))
})
afterEach(async () => {
  vi.useRealTimers()
  orchestration.close()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function botAutomation(store: Store) {
  const group = store.createProjectGroup({
    name: 'Agents',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  store.saveBot(makeTestBot({ folderWorkspaceId: folder.id }))
  return store.createAutomation({
    name: 'Daily report',
    prompt: 'Report',
    agentId: 'codex',
    projectId: '',
    workspaceMode: 'existing',
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.now()
  })
}

/** One host where no chat holds any run's prompt; group rooms are read from `orchestration`. */
function hostOf() {
  const runtime = {
    openAgentSessionRecordStore: async () => ({
      chatsHoldingRun: async () => ({ byMessage: [], byRun: [] })
    }),
    getOrchestrationDb: () => orchestration
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the reads recovery makes
  return { runtime: runtime as unknown as OrcaRuntimeService }
}

/** One Orca process: the service and its completion watcher, recovering as the runtime's own
 *  observer does; `observed` lists runs it watched to their end itself. */
function startOrca(
  store: Store,
  runtime: OrcaRuntimeService,
  botDispatcher: AutomationBotLauncher
) {
  const observed: string[] = []
  const service: AutomationService = new AutomationService(store, {
    botDispatcher,
    terminalObserver: {
      resolveRunTerminal: (run) => `automation:${run.id}`,
      observeCompletion: async (_handle, { run, signal }) => {
        const automation = store.listAutomations().find((entry) => entry.id === run!.automationId)!
        const recovered = await recoverSelfSentRun(selfSent, automation, run!, signal)
        if ('settled' in recovered) {
          return recovered.settled
        }
        // As the runtime's observer: a run with no chat can't be confirmed.
        if (!recovered.run.chatSessionId) {
          return { status: 'dispatch_failed', error: 'unconfirmed' }
        }
        observed.push(recovered.run.id)
        return { status: 'completed' }
      }
    }
  })
  const selfSent = { runtime, service }
  return { service, observed }
}

const hangs: AutomationBotLauncher = () => new Promise(() => {})
const launched = (runs: string[]): AutomationBotLauncher =>
  vi.fn(async ({ run, target }) => {
    runs.push(run.id)
    return {
      sessionKind: 'chat' as const,
      chatSessionId: 'chat-1',
      workspaceId: target.workspaceId,
      terminalSessionId: null,
      completion: Promise.resolve({ status: 'completed' as const })
    }
  })

async function quitMidDispatch(store: Store, runtime: OrcaRuntimeService): Promise<AutomationRun> {
  const automation = botAutomation(store)
  const first = startOrca(store, runtime, hangs).service
  const run = await first.runNow(automation.id)
  await vi.waitFor(() => expect(runOf(store, run).status).toBe('dispatching'))
  first.stop()
  return run
}

const runOf = (store: Store, run: AutomationRun) =>
  store.listAutomationRuns(run.automationId).find((entry) => entry.id === run.id)!

it('resumes a run whose prompt reached nothing through its own launch, which alone settles it', async () => {
  const store = createStore()
  const { runtime } = hostOf()
  const run = await quitMidDispatch(store, runtime)
  const sent: string[] = []
  const second = startOrca(store, runtime, launched(sent))
  const writes = vi.spyOn(second.service, 'markDispatchResult')
  second.service.start()
  await vi.waitFor(() => expect(runOf(store, run).status).toBe('completed'))
  expect(sent).toEqual([run.id])
  expect(second.observed).toEqual([])
  expect(writes.mock.calls.filter(([result]) => result.status === 'completed')).toHaveLength(1)
  second.service.stop()
})

it('skips a resumed run as any launch would when its target is paused now', async () => {
  const store = createStore()
  const { runtime } = hostOf()
  const run = await quitMidDispatch(store, runtime)
  const folderWorkspaceId = store.getBots()[0]!.folderWorkspaceId
  store.saveBot(makeTestBot({ folderWorkspaceId, paused: true }))
  const sent: string[] = []
  const second = startOrca(store, runtime, launched(sent)).service
  second.start()
  await vi.waitFor(() => expect(runOf(store, run).status).toBe('skipped_unavailable'))
  expect(sent).toEqual([])
  second.stop()
})

it('never resumes an existing dispatching run a later request reuses', async () => {
  const store = createStore()
  const { runtime } = hostOf()
  const run = await quitMidDispatch(store, runtime)
  const sent: string[] = []
  const second = startOrca(store, runtime, launched(sent)).service
  // Same occurrence: the store hands back the claimed run rather than a new one.
  vi.setSystemTime(run.scheduledFor)
  expect((await second.runNow(run.automationId)).id).toBe(run.id)
  // Its lane runs the request after runNow returns; an empty turn behind it waits for that request.
  await second.runInAutomationLane(run.automationId, async () => {})
  expect(sent).toEqual([])
  expect(runOf(store, run).status).toBe('dispatching')
})

it('leaves the run for the next start when Orca quits during the resumed launch', async () => {
  const store = createStore()
  const { runtime } = hostOf()
  const run = await quitMidDispatch(store, runtime)
  let stopped: ((error: Error) => void) | null = null
  const second = startOrca(store, runtime, () => new Promise((_, reject) => (stopped = reject)))
  second.service.start()
  await vi.waitFor(() => expect(stopped).not.toBeNull())
  second.service.stop()
  stopped!(new Error('host stopped'))
  // The failed launch settles in its lane, then its failure handler runs on a later turn.
  await second.service.runInAutomationLane(run.automationId, async () => {})
  await yieldToEventLoop()
  expect(runOf(store, run)).toMatchObject({ status: 'dispatching', chatSessionId: null })
})

/** The run's prompt as a room post its member's chat is still owed. */
function owedRoomPost(runtime: OrcaRuntimeService, run: AutomationRun) {
  const operationId = automationRunOperationId(run, 'run-message')
  const groups = runtimeBotGroups(runtime)
  groups.store.append(
    {
      id: `post-${run.id}`,
      groupId: 'group-1',
      author: { kind: 'owner' },
      text: 'Report',
      createdAt: NOW,
      turns: [
        {
          operationId,
          botId: 'bot-1',
          botName: 'Reviewer',
          avatar: null,
          agent: 'codex',
          sessionId: 'member-chat'
        }
      ]
    },
    new Map([[operationId, 'context']])
  )
  return { groups, operationId }
}

it('never re-dispatches a run whose prompt a room post holds, owed or revoked', async () => {
  for (const state of ['owed', 'revoked'] as const) {
    const store = createStore()
    const { runtime } = hostOf()
    const run = await quitMidDispatch(store, runtime)
    const { groups, operationId } = owedRoomPost(runtime, run)
    if (state === 'revoked') {
      const post = groups.store.message(`post-${run.id}`)!
      groups.store.delivered([operationId])
      groups.store.update({
        ...post,
        turns: post.turns.map((turn) => ({ ...turn, revoked: true }))
      })
    }
    const sent: string[] = []
    const second = startOrca(store, runtime, launched(sent))
    second.service.start()
    await vi.waitFor(() => expect(runOf(store, run).status).toBe('dispatch_failed'))
    expect(runOf(store, run).error).toBe('unconfirmed')
    expect(sent).toEqual([])
    second.service.stop()
    await closeTestStores()
  }
})

it('never hands on a run that is no longer claimed, even with no chat', async () => {
  const store = createStore()
  const { runtime } = hostOf()
  const run = await quitMidDispatch(store, runtime)
  store.updateAutomationRun({ runId: run.id, status: 'dispatched', chatSessionId: null })
  const sent: string[] = []
  const second = startOrca(store, runtime, launched(sent))
  second.service.start()
  await vi.waitFor(() => expect(runOf(store, run).status).toBe('dispatch_failed'))
  expect(sent).toEqual([])
  second.service.stop()
})
