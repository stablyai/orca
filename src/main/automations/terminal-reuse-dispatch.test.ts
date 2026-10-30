import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { createAgentPromptSubmissionRuntime } from '../runtime/agent-prompt-submission-runtime-test-fixture'
import {
  runtimeStub,
  setAgentLaunchRecordStore
} from '../runtime/rpc/methods/agent-launch.test-fixture'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import * as transcripts from '../native-chat/transcript-watch'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'
import { AutomationService } from './service'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { normalizeCodexEvent } from '../../shared/agent-hook-listener/providers/codex-events'
import { bindHeadlessRunTerminalRetention } from './runtime-run-terminal-retention'
import { RUN_TERMINAL_GRACE_MS } from './headless-run-terminal-retention'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString()
  }
}))
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn(async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ]),
  listWorktreesStrict: vi.fn(async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ])
}))
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  setAgentLaunchRecordStore(null)
  vi.restoreAllMocks()
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
const json = (value: unknown) => `${JSON.stringify(value)}\n`
const event = (payload: unknown) => json({ type: 'event_msg', payload })

it('retains repeated delivered input through old-turn Done until the live CLI consumes it and exits', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-reuse-retention-'))
  directories.push(testState.dir)
  const store = await createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'Repo', badgeColor: '#fff', addedAt: 1 })
  const automation = store.createAutomation({
    name: 'Queued audit',
    prompt: 'seed',
    agentId: 'codex',
    enabled: false,
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'r1::/tmp/worktree-a',
    reuseSession: true,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.now()
  })
  const queued: string[] = []
  const consumed: string[] = []
  let draft = ''
  // Composed external TUI boundary: Enter queues; admission occurs later. This is not a CLI capture.
  const rig = await createAgentPromptSubmissionRuntime((ptyRuntime, data) => {
    ptyRuntime.onPtyData('pty-prompt', '› draft\n\x1b[?25h', Date.now())
    if (data.includes('\x1b[200~')) {
      draft = data.split('\x1b[200~')[1]!.split('\x1b[201~')[0]!
    }
    if (data.endsWith('\r') && draft) {
      queued.push(draft)
      draft = ''
    }
  }, 'codex')
  const pane = rig.runtime.getTerminalPaneKey(rig.handle)!
  const binding = rig.runtime.getTerminalPromptRequestBinding(rig.handle)
  const listener = createHookListenerState()
  const normalize = (eventName: string, turn: string) =>
    normalizeCodexEvent(listener, eventName, '', pane, { session_id: 'session', turn_id: turn })!
  let row = normalize('UserPromptSubmit', 'seed-turn')
  let shell = false
  let revokeAtClose = false
  const stopped: string[] = []
  const close = vi.fn(async (handle: string, options: { beforeAction: () => void }) => {
    await Promise.resolve()
    if (revokeAtClose) {
      row = normalize('UserPromptSubmit', 'woken-turn')
    }
    options.beforeAction()
    stopped.push(handle)
    return {}
  })
  const records = await openTestAgentSessionRecordStore(join(testState.dir, 'ledger'))
  setAgentLaunchRecordStore(records)
  const external = runtimeStub({ terminalPaneKey: pane, lineCarriesPrompt: false })
  external.requireStore.mockReturnValue(store)
  external.createTerminal.mockImplementation(async () => {
    // The external controller's spawn commit precedes launch writes, through the real fact owner.
    rig.runtime.terminalRunFacts.recordSpawnCommit({
      id: binding.ptyId,
      incarnationId: binding.processIncarnation
    })
    return { handle: rig.handle, paneKey: pane }
  })
  external.hasLiveTerminalForPaneKey.mockReturnValue(true)
  external.getTerminalHandleForPaneKey.mockImplementation((key) =>
    key === pane ? rig.handle : key
  )
  external.showTerminal.mockResolvedValue({
    handle: rig.handle,
    worktreeId: automation.workspaceId!
  })
  external.showTerminalWorkspaceLaunchScope.mockResolvedValue({
    id: automation.workspaceId!,
    path: '/tmp/worktree-a',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const runtime = Object.assign(new OrcaRuntimeService(store), external, {
    getTerminalPromptRequestBinding: rig.runtime.getTerminalPromptRequestBinding.bind(rig.runtime),
    getTerminalPaneKey: () => pane,
    getTerminalPtyIdForHandle: (handle: string) =>
      handle === rig.handle ? (stopped.includes(handle) ? null : binding.ptyId) : `pty:${handle}`,
    getTerminalProcessIncarnation: (handle: string) =>
      handle === rig.handle ? binding.processIncarnation : 'sibling',
    getAgentStatusRowsForPane: (key: string) => [
      {
        ...(key === pane ? row : { state: 'done' }),
        connectionId: null,
        terminalHandle: key === pane ? rig.handle : key
      }
    ],
    readObservedAgentStatusPaneIdentityFn: (key: string) => ({
      kind: 'observed',
      terminalHandle: key === pane ? rig.handle : key,
      processIncarnation: key === pane ? binding.processIncarnation : 'sibling'
    }),
    readTerminalClientUse: (pty: string) =>
      pty === binding.ptyId ? rig.runtime.readTerminalClientUse(pty) : 'used',
    confirmTerminalShellAlone: vi.fn(async () => shell),
    closeTerminal: close,
    sleepTerminalsForWorktree: vi.fn(),
    readLaunchedAgentForeground: rig.runtime.readLaunchedAgentForeground.bind(rig.runtime),
    subscribeToTerminalData: rig.runtime.subscribeToTerminalData.bind(rig.runtime),
    sendTerminalAgentPrompt: rig.runtime.sendTerminalAgentPrompt.bind(rig.runtime),
    waitForTerminal: async () => ({ satisfied: true }),
    showManagedWorktree: async () => ({ displayName: 'Audit' })
  })
  const service = new AutomationService(store, {
    allowRemoteHostScheduling: true,
    headlessDispatcher: async (request) => {
      const { terminalHandle: _handle, ...launch } = await launchHeadlessAutomationAgent(runtime, {
        ...request,
        runs: store.listAutomationRuns(automation.id)
      })
      return launch
    }
  })
  try {
    for (const text of ['seed', 'queued one', 'queued two']) {
      store.updateAutomation(automation.id, { prompt: text })
      const run = await service.runNow(automation.id)
      expect(run).toMatchObject({
        status: 'dispatched',
        terminalPaneKey: pane,
        terminalPtyId: binding.ptyId
      })
      expect(readAutomationRunReceipt(records, run)).toMatchObject({
        kind: 'terminal',
        accepted: true
      })
      if (text === 'seed') {
        consumed.push(queued.shift()!)
      }
    }
    expect(external.createTerminal).toHaveBeenCalledOnce()
    expect(queued).toEqual(['queued one', 'queued two'])
    expect(rig.writes.filter((data) => data.includes('\x1b[200~'))).toHaveLength(3)
    expect(runtime.readTerminalClientUse(binding.ptyId)).toBe('unused')
    const newest = store.listAutomationRuns(automation.id)[0]!
    expect(newest.status).toBe('dispatched')
    vi.useFakeTimers()
    bindHeadlessRunTerminalRetention(service, store, runtime)
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 60_000)
    expect(close).not.toHaveBeenCalled()
    // Three newer distinct live panes make the queued pane eligible without viewing or driving it.
    for (let n = 0; n < 3; n += 1) {
      const siblingPane = `${randomUUID()}:${randomUUID()}`
      const sibling = store.createAutomationRun(automation, Date.now() + n, 'manual')
      store.updateAutomationRun({
        runId: sibling.id,
        status: 'completed',
        terminalPaneKey: siblingPane,
        terminalPtyId: `pty:${siblingPane}`,
        sessionKind: 'terminal'
      })
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(close).not.toHaveBeenCalled()
    row = normalize('Stop', 'seed-turn')
    expect(row.state).toBe('done')
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(close).not.toHaveBeenCalled()
    expect(runtime.sleepTerminalsForWorktree).not.toHaveBeenCalled()
    expect(
      store.listAutomationRuns(automation.id).find((run) => run.id === newest.id)
    ).toMatchObject({
      status: 'dispatched',
      terminalPaneKey: pane,
      terminalPtyId: binding.ptyId
    })
    expect(queued).toEqual(['queued one', 'queued two'])
    // A newer starting owner does not let the older delivery authorize retirement.
    const starting = store.createAutomationRun(automation, Date.now(), 'manual')
    store.updateAutomationRun({
      runId: starting.id,
      status: 'dispatching',
      terminalPaneKey: pane,
      terminalPtyId: binding.ptyId
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(close).not.toHaveBeenCalled()
    store.updateAutomationRun({
      runId: starting.id,
      status: 'dispatch_failed',
      terminalPaneKey: null,
      terminalPtyId: null
    })
    // The native boundary later consumes each accepted prompt once; no result is invented from that simulation.
    for (const turn of ['one', 'two']) {
      row = normalize('UserPromptSubmit', turn)
      consumed.push(queued.shift()!)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(close).not.toHaveBeenCalled()
      row = normalize('Stop', turn)
    }
    expect(consumed).toEqual(['seed', 'queued one', 'queued two'])
    expect(queued).toEqual([])
    // A positive exit/shell verdict permits cleanup, subject to the actual final-boundary recheck.
    shell = true
    revokeAtClose = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(close).toHaveBeenCalledOnce()
    expect(stopped).toEqual([])
    expect(
      store.listAutomationRuns(automation.id).find((run) => run.id === newest.id)?.terminalPtyId
    ).toBe(binding.ptyId)
    revokeAtClose = false
    row = normalize('Stop', 'woken-turn')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stopped).toEqual([rig.handle])
    expect(
      store.listAutomationRuns(automation.id).find((run) => run.id === newest.id)
    ).toMatchObject({
      status: 'dispatched',
      terminalPaneKey: null,
      terminalPtyId: null
    })
    expect(external.createTerminal).toHaveBeenCalledOnce()
    expect(rig.writes.filter((data) => data.includes('\x1b[200~'))).toHaveLength(3)
    await expect(service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(stopped).toEqual([rig.handle])
  } finally {
    service.stop()
  }
})

const metrics = new Map<
  string,
  { visits: number; projections: number; snapshots: number; records: number; sorts: number }
>()
it.each([
  ['claude', 100],
  ['claude', 1000],
  ['codex', 100],
  ['codex', 1000]
] as const)(
  'composes real dispatch/ledger/writer/result across a %s seed and two reused completions with live background work and %i unrelated rows',
  async (agent, population) => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-terminal-reuse-dispatch-'))
    directories.push(testState.dir)
    const store = await createStore()
    store.addRepo({ id: 'r1', path: '/repo', displayName: 'Repo', badgeColor: '#fff', addedAt: 1 })
    const automation = store.createAutomation({
      name: 'Repeated audit',
      prompt: 'seed',
      agentId: agent,
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::/tmp/worktree-a',
      reuseSession: true,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now()
    })
    for (let n = 0; n < population; n += 1) {
      const other = store.createAutomation({ ...automation, enabled: false, name: `Other ${n}` })
      const run = store.createAutomationRun(other, n, 'manual')
      store.updateAutomationRun({ runId: run.id, status: 'dispatched' })
    }
    const counters = { visits: 0, projections: 0, snapshots: 0, records: 0, sorts: 0 }
    const listRuns = store.listAutomationRuns.bind(store)
    const listDefinitions = store.listAutomations.bind(store)
    vi.spyOn(store, 'listAutomationRuns').mockImplementation((id) => {
      const runs = listRuns(id)
      counters.visits += runs.length
      return runs
    })
    vi.spyOn(store, 'listAutomations').mockImplementation(() => {
      const definitions = listDefinitions()
      counters.visits += definitions.length
      return definitions
    })
    const path = join(testState.dir, 'session.jsonl')
    writeFileSync(path, agent === 'codex' ? event({ type: 'task_started', turn_id: 'old' }) : '')
    let draft = ''
    let cycle = 0
    let subscriptions = 0
    let caughtUp = 0
    const subscribe = transcripts.subscribeNativeChatTranscript
    vi.spyOn(transcripts, 'subscribeNativeChatTranscript').mockImplementation((args, signal) => {
      subscriptions += 1
      const subscription = subscriptions
      return subscribe(
        {
          ...args,
          debounceMs: 0,
          reconciliationIntervalMs: 10,
          onRecord: (row) => {
            if (row.kind === 'record') {
              counters.records += 1
            }
            args.onRecord?.(row)
            if (row.kind === 'caught-up') {
              caughtUp = Math.max(caughtUp, subscription)
            }
          }
        },
        signal
      )
    })
    // External PTY/agent boundary only. These later cycles and Claude lineage are composed, not captures.
    const rig = await createAgentPromptSubmissionRuntime((ptyRuntime, data) => {
      ptyRuntime.onPtyData(
        'pty-prompt',
        data.includes('\x1b[200~') ? '› draft\n\x1b[?25h' : 'answer\n',
        Date.now()
      )
      if (data.includes('\x1b[200~')) {
        draft = data.split('\x1b[200~')[1]!.split('\x1b[201~')[0]!
      }
      if (!data.endsWith('\r') || !draft) {
        return
      }
      const text = draft
      draft = ''
      const root = `T${cycle}`
      appendFileSync(
        path,
        agent === 'codex'
          ? event({ type: 'task_started', turn_id: root }) +
              event({
                type: 'item_completed',
                turn_id: root,
                item: { id: `U${cycle}`, type: 'UserMessage', content: [{ type: 'text', text }] }
              }) +
              event({ type: 'agent_message', turn_id: root, message: `answer ${cycle}` }) +
              event({ type: 'task_complete', turn_id: root })
          : json({
              type: 'user',
              sessionId: 'session',
              uuid: root,
              parentUuid: null,
              message: { role: 'user', content: text }
            }) +
              json({
                type: 'assistant',
                sessionId: 'session',
                uuid: `A${cycle}`,
                parentUuid: root,
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: `answer ${cycle}` }],
                  stop_reason: 'end_turn'
                }
              })
      )
    }, agent)
    // Shape a real asynchronous foreground read so the source can establish its cursor before Enter.
    vi.spyOn(rig.runtime, 'readLaunchedAgentForeground').mockImplementation(async () => {
      await vi.waitFor(() => expect(caughtUp).toBeGreaterThanOrEqual(subscriptions))
      return 'agent'
    })
    const pane = rig.runtime.getTerminalPaneKey(rig.handle)!
    const binding = rig.runtime.getTerminalPromptRequestBinding(rig.handle)
    Object.assign(rig.runtime, {
      getAgentStatusSnapshotFn: () => {
        counters.snapshots += population
        return Array.from({ length: population }, (_, n) => ({
          paneKey: `unrelated-${n}`,
          state: 'working',
          agentType: agent,
          receivedAt: Date.now(),
          connectionId: null
        }))
      }
    })
    const recordStore = await openTestAgentSessionRecordStore(join(testState.dir, 'ledger'))
    setAgentLaunchRecordStore(recordStore)
    const external = runtimeStub({ terminalPaneKey: pane, lineCarriesPrompt: false })
    external.requireStore.mockReturnValue(store)
    external.hasLiveTerminalForPaneKey.mockReturnValue(true)
    external.createTerminal.mockResolvedValue({ handle: rig.handle, paneKey: pane })
    external.getTerminalHandleForPaneKey.mockReturnValue(rig.handle)
    external.showTerminal.mockResolvedValue({
      handle: rig.handle,
      worktreeId: 'r1::/tmp/worktree-a'
    })
    external.showTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'r1::/tmp/worktree-a',
      path: '/tmp/worktree-a',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    const row = {
      agentType: agent,
      state: 'working',
      receivedAt: 1,
      executionId: 'execution',
      connectionId: null,
      providerSession: { id: 'session', key: 'session_id', transcriptPath: path },
      subagents: [{ id: 'monitor', kind: 'shell', state: 'working' }]
    }
    let monitor: AgentHookEventPayload | null = null
    if (agent === 'claude') {
      const listener = createHookListenerState()
      const captured: { scenario: string; t: number; payload?: Record<string, unknown> }[] =
        readFileSync(
          join(__dirname, '../../shared/__fixtures__/claude-task-notification-hooks.jsonl'),
          'utf8'
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      for (const record of captured) {
        if (record.scenario === 'monitor-events' && record.t <= 6.882 && record.payload) {
          monitor =
            normalizeHookPayload(
              listener,
              'claude',
              { paneKey: pane, payload: record.payload },
              'production'
            ) ?? monitor
        }
      }
      expect(monitor?.payload.state).toBe('working')
      expect(monitor?.claudeRunningNonAgentTask).toBe(true)
      Object.assign(row, monitor?.payload, {
        claudeRunningNonAgentTask: monitor?.claudeRunningNonAgentTask
      })
    }
    const runtime = Object.assign(new OrcaRuntimeService(store), external, {
      getTerminalPromptRequestBinding: rig.runtime.getTerminalPromptRequestBinding.bind(
        rig.runtime
      ),
      getTerminalPtyIdForHandle: rig.runtime.getTerminalPtyIdForHandle.bind(rig.runtime),
      getTerminalPaneKey: rig.runtime.getTerminalPaneKey.bind(rig.runtime),
      getAgentStatusRowsForPane: () => [row],
      readObservedAgentStatusPaneIdentityFn: () => ({
        kind: 'observed',
        terminalHandle: rig.handle,
        processIncarnation: binding.processIncarnation
      }),
      readLaunchedAgentForeground: rig.runtime.readLaunchedAgentForeground.bind(rig.runtime),
      subscribeToTerminalData: rig.runtime.subscribeToTerminalData.bind(rig.runtime),
      sendTerminalAgentPrompt: rig.runtime.sendTerminalAgentPrompt.bind(rig.runtime),
      waitForTerminal: async () => ({ satisfied: true }),
      showManagedWorktree: async () => ({ displayName: 'Audit' })
    })
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)
    let service: AutomationService
    service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      terminalObserver: observer,
      headlessDispatcher: async (request) => {
        const observation = service.reserveTerminalRun(
          request.run,
          request.automation.prompt,
          agent
        )
        const { terminalHandle: _handle, ...launch } = await launchHeadlessAutomationAgent(
          runtime,
          { ...request, observation, runs: store.listAutomationRuns(automation.id) }
        )
        observation?.deliverySettled()
        return launch
      }
    })
    const advance = vi.spyOn(store, 'advanceAutomationNextRun')
    const flush = store.flushPendingOrThrowAsync.bind(store)
    const lostAck = Promise.withResolvers<void>()
    let stalled = false
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockImplementation(async (options) => {
      if (
        cycle === 3 &&
        !stalled &&
        store.listAutomationRuns(automation.id).some((run) => run.status === 'dispatched')
      ) {
        stalled = true
        await lostAck.promise
      }
      await flush(options)
    })
    // Count domain-row populations, including scans before list APIs return; runner/assertion arrays are not production rows.
    const populationOf = (rows: unknown[]): number => {
      const row = rows[0]
      return row &&
        typeof row === 'object' &&
        ('automationId' in row ||
          ('rrule' in row && 'agentId' in row) ||
          ('paneKey' in row && 'agentType' in row))
        ? rows.length
        : 0
    }
    const filter = Array.prototype.filter
    vi.spyOn(Array.prototype, 'filter').mockImplementation(function (
      this: unknown[],
      predicate,
      thisArg
    ) {
      counters.visits += populationOf(this)
      return filter.call(this, predicate, thisArg)
    })
    const map = Array.prototype.map
    vi.spyOn(Array.prototype, 'map').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg
    ) {
      counters.projections += populationOf(this)
      return map.call(this, callback, thisArg)
    })
    const sort = Array.prototype.sort
    vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
      counters.sorts += populationOf(this)
      return sort.call(this, compare)
    })
    const toSorted = Array.prototype.toSorted
    vi.spyOn(Array.prototype, 'toSorted').mockImplementation(function (this: unknown[], compare) {
      counters.sorts += populationOf(this)
      return toSorted.call(this, compare)
    })
    // Whole trigger: counters start before dispatch, including every seed and reuse to persisted result.
    Object.assign(counters, { visits: 0, projections: 0, snapshots: 0, records: 0, sorts: 0 })
    try {
      for (cycle = 0; cycle < 4; cycle += 1) {
        store.updateAutomation(automation.id, { prompt: `distinct prompt ${cycle}` })
        const scheduled = cycle === 1 || cycle === 2
        const now = Date.now.bind(Date)
        const offset =
          store.listAutomations().find((entry) => entry.id === automation.id)!.nextRunAt - now()
        const clock = scheduled
          ? vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
          : undefined
        if (scheduled) {
          service.setRendererReady()
        }
        const settled = scheduled
          ? null
          : service.runNow(automation.id).catch((error: unknown) => error)
        await vi.waitFor(
          () =>
            expect(
              store.listAutomationRuns(automation.id).filter((run) => run.status === 'completed')
            ).toHaveLength(cycle + 1),
          { timeout: 5000 }
        )
        if (cycle === 3) {
          lostAck.reject(new Error('lost dispatched acknowledgement'))
        }
        if (scheduled) {
          await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(cycle))
          expect(
            store.listAutomationRuns(automation.id).filter((run) => run.trigger === 'scheduled')
          ).toHaveLength(cycle)
        } else {
          const returned: unknown = await settled
          if (cycle === 3) {
            expect(returned).toBeInstanceOf(Error)
          } else {
            expect(returned).toMatchObject({ status: 'dispatched' })
          }
        }
        clock?.mockRestore()
        const runs = store.listAutomationRuns(automation.id)
        const current = runs.find((run) => run.outputSnapshot?.content === `answer ${cycle}`)!
        expect(readAutomationRunReceipt(recordStore, current)).toMatchObject({
          kind: 'terminal',
          accepted: true
        })
        expect(
          runs.every((run) => run.terminalPaneKey === pane && run.terminalPtyId === binding.ptyId)
        ).toBe(true)
        expect(runs.some((run) => run.outputSnapshot?.content === `answer ${cycle}`)).toBe(true)
      }
      expect(external.createTerminal).toHaveBeenCalledOnce()
      expect(rig.writes.filter((data) => data.includes('distinct prompt'))).toHaveLength(4)
      console.info('whole-dispatch-cost', agent, population, counters)
      for (const value of Object.values(counters)) {
        expect(value).toBeGreaterThan(0)
      }
      expect(
        counters.visits +
          counters.projections +
          counters.snapshots +
          counters.records +
          counters.sorts
      ).toBeLessThan(1500 * population)
      if (population === 1000) {
        const small = metrics.get(agent)!
        for (const key of ['visits', 'projections', 'snapshots', 'records', 'sorts'] as const) {
          expect(counters[key]).toBeLessThanOrEqual(12 * small[key] + 100)
        }
      } else {
        metrics.set(agent, { ...counters })
      }
      expect(row.state).toBe('working')
      if (agent === 'claude') {
        expect(monitor?.claudeRunningNonAgentTask).toBe(true)
      } else {
        expect(row.subagents[0]?.state).toBe('working')
      }
    } finally {
      lostAck.resolve()
      service.stop()
      await service.runInAutomationLane(automation.id, async () => {})
    }
  },
  120_000
)

it.each(['zero', 'partial', 'unknown', 'accepted', 'abort'] as const)(
  'settles the real reuse operation and dispatch without duplicating %s effects',
  async (effect) => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-reuse-effects-'))
    directories.push(testState.dir)
    const store = await createStore()
    store.addRepo({ id: 'r1', path: '/repo', displayName: 'Repo', badgeColor: '#fff', addedAt: 1 })
    const automation = store.createAutomation({
      name: 'Audit',
      prompt: 'check once',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::/tmp/worktree-a',
      reuseSession: true,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.now()
    })
    let shellReturn: (() => void) | undefined
    let foreground: 'agent' | 'shell' = effect === 'zero' ? 'shell' : 'agent'
    const controller = new AbortController()
    const rig = await createAgentPromptSubmissionRuntime(
      (_runtime, data) => {
        if (data.includes('check once') && effect === 'partial') {
          foreground = 'shell'
          shellReturn?.()
        }
        if (data === '\r' && effect === 'accepted') {
          controller.abort()
        }
      },
      'claude',
      () => {
        if (effect === 'unknown') {
          throw new Error('lost write acknowledgement')
        }
        return true
      }
    )
    vi.spyOn(rig.runtime, 'readLaunchedAgentForeground').mockImplementation(async () => foreground)
    vi.spyOn(rig.runtime, 'subscribeToTerminalData').mockImplementation((_pty, callback) => {
      shellReturn = () => callback('\x1b]133;A\x07')
      return () => {
        shellReturn = undefined
      }
    })
    const pane = rig.runtime.getTerminalPaneKey(rig.handle)!
    const previous = store.createAutomationRun(automation, 1, 'manual')
    store.updateAutomationRun({
      runId: previous.id,
      status: 'completed',
      workspaceId: automation.workspaceId,
      terminalPaneKey: pane,
      terminalPtyId: 'pty-prompt',
      sessionKind: 'terminal'
    })
    const records = await openTestAgentSessionRecordStore(join(testState.dir, 'ledger'))
    setAgentLaunchRecordStore(records)
    const external = runtimeStub({
      terminalPaneKey: 'fresh-tab:fresh-leaf',
      lineCarriesPrompt: true
    })
    external.requireStore.mockReturnValue(store)
    external.showTerminal.mockResolvedValue({
      handle: rig.handle,
      worktreeId: automation.workspaceId!
    })
    external.hasLiveTerminalForPaneKey.mockReturnValue(true)
    external.getTerminalHandleForPaneKey.mockImplementation((key) =>
      key === pane ? rig.handle : null
    )
    external.isTerminalRunningAgent.mockImplementation(async () => {
      if (effect === 'abort') {
        controller.abort()
      }
      return true
    })
    const binding = rig.runtime.getTerminalPromptRequestBinding(rig.handle)
    const runtime = Object.assign(new OrcaRuntimeService(store), external, {
      getTerminalPaneKey: (handle: string) =>
        handle === rig.handle ? pane : 'fresh-tab:fresh-leaf',
      getTerminalPtyIdForHandle: (handle: string) =>
        handle === rig.handle ? 'pty-prompt' : 'pty-fresh',
      getTerminalPromptRequestBinding: () => binding,
      getAgentStatusRowsForPane: () => [{ agentType: 'claude', state: 'working', receivedAt: 1 }],
      readLaunchedAgentForeground: rig.runtime.readLaunchedAgentForeground.bind(rig.runtime),
      subscribeToTerminalData: rig.runtime.subscribeToTerminalData.bind(rig.runtime),
      sendTerminalAgentPrompt: rig.runtime.sendTerminalAgentPrompt.bind(rig.runtime)
    })
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      headlessDispatcher: async (request) => {
        const { terminalHandle: _handle, ...launch } = await launchHeadlessAutomationAgent(
          runtime,
          {
            ...request,
            runs: store.listAutomationRuns(automation.id),
            observation: {
              signal: controller.signal,
              assertCurrent: () => {
                if (controller.signal.aborted) {
                  throw new Error('request_aborted')
                }
              },
              bind: () => {},
              submitted: () => {},
              deliverySettled: () => {},
              release: () => {}
            }
          }
        )
        return launch
      }
    })
    try {
      const run = await service.runNow(automation.id)
      expect(external.createTerminal).toHaveBeenCalledTimes(effect === 'zero' ? 1 : 0)
      expect(rig.writes.filter((data) => data.includes('check once'))).toHaveLength(
        effect === 'zero' || effect === 'abort' ? 0 : 1
      )
      expect(run.status).toBe(
        effect === 'zero' || effect === 'accepted' ? 'dispatched' : 'dispatch_failed'
      )
      const receipt = readAutomationRunReceipt(records, run)
      if (effect === 'abort') {
        expect(receipt?.accepted ?? false).toBe(false)
      } else {
        expect(receipt).toMatchObject({
          kind: 'terminal',
          accepted: effect === 'zero' || effect === 'accepted'
        })
      }
      if (effect === 'zero') {
        expect(run.terminalPtyId).toBe('pty-fresh')
        expect(external.createTerminal.mock.calls[0]?.[1]).toMatchObject({
          startupPrompt: 'check once'
        })
      }
    } finally {
      service.stop()
      controller.abort()
    }
  }
)
