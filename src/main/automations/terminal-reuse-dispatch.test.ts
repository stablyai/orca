import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { createAgentPromptSubmissionRuntime } from '../runtime/agent-prompt-submission-runtime-test-fixture'
import {
  runtimeStub,
  setAgentLaunchRecordStore
} from '../runtime/rpc/methods/agent-launch.test-fixture'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import * as transcripts from '../native-chat/transcript-watch'
import * as transcriptReaders from '../native-chat/transcript-incremental-reader'
import * as transcriptDecoders from '../native-chat/transcript-tail-reader'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import * as statusProjection from '../runtime/runtime-worktree-status-projection'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'
import { AutomationService } from './service'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString()
  }
}))
vi.mock('../git/worktrees/catalog/worktree-scan-cache', () => ({
  listWorktrees: vi.fn(async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ]),
  listWorktreesStrict: vi.fn(async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ])
}))
vi.mock('../git/worktrees/catalog/worktree-listing', () => ({
  listWorktreesStrict: vi.fn(async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ])
}))
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  setAgentLaunchRecordStore(null)
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
const json = (value: unknown) => `${JSON.stringify(value)}\n`
const event = (payload: unknown) => json({ type: 'event_msg', payload })

const metrics = new Map<
  string,
  { visits: number; projections: number; snapshots: number; normalizations: number; sorts: number }
>()
it.each([
  ['claude', 100],
  ['claude', 1000],
  ['codex', 100],
  ['codex', 1000]
] as const)(
  'delivers overlapping %s prompts once with %i unrelated runs, definitions and transcript records',
  async (agent, population) => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-terminal-reuse-dispatch-'))
    directories.push(testState.dir)
    const store = await createStore()
    store.addRepo({ id: 'r1', path: '/repo', displayName: 'Repo', badgeColor: '#fff', addedAt: 1 })
    const automation = store.createAutomation({
      name: 'Repeated audit',
      prompt: 'same prompt',
      agentId: agent,
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::/tmp/worktree-a',
      reuseSession: true,
      timezone: 'UTC',
      rrule: 'FREQ=HOURLY;BYMINUTE=0',
      dtstart: Date.now()
    })
    for (let n = 0; n < population; n += 1) {
      const other = store.createAutomation({ ...automation, enabled: false, name: `Other ${n}` })
      const run = store.createAutomationRun(other, n, 'manual')
      store.updateAutomationRun({ runId: run.id, status: 'dispatched' })
    }
    const path = join(testState.dir, 'session.jsonl')
    const answer = (id: string) =>
      agent === 'codex'
        ? event({ type: 'task_started', turn_id: id }) +
          event({
            type: 'item_completed',
            turn_id: id,
            item: {
              id: `U-${id}`,
              type: 'UserMessage',
              content: [{ type: 'text', text: 'same prompt' }]
            }
          }) +
          event({ type: 'agent_message', turn_id: id, message: `answer ${id}` }) +
          event({ type: 'task_complete', turn_id: id })
        : json({
            type: 'user',
            sessionId: 'session',
            uuid: id,
            parentUuid: null,
            message: { role: 'user', content: 'same prompt' }
          }) +
          json({
            type: 'assistant',
            sessionId: 'session',
            uuid: `A-${id}`,
            parentUuid: id,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `answer ${id}` }],
              stop_reason: 'end_turn'
            }
          })
    writeFileSync(
      path,
      Array.from({ length: population }, (_, n) => answer(`history-${n}`)).join('')
    )
    // External queue boundary, not a recorded CLI capture: an earlier identical input has not committed.
    const queued = ['same prompt']
    let draft = ''
    const rig = await createAgentPromptSubmissionRuntime((ptyRuntime, data) => {
      ptyRuntime.onPtyData('pty-prompt', '› draft\n\x1b[?25h', Date.now())
      if (data.includes('\x1b[200~')) {
        draft = data.split('\x1b[200~')[1]!.split('\x1b[201~')[0]!
      }
      if (data.endsWith('\r') && draft) {
        queued.push(draft)
        draft = ''
      }
    }, agent)
    const pane = rig.runtime.getTerminalPaneKey(rig.handle)!
    const binding = rig.runtime.getTerminalPromptRequestBinding(rig.handle)
    const recordStore = await openTestAgentSessionRecordStore(join(testState.dir, 'ledger'))
    setAgentLaunchRecordStore(recordStore)
    const external = runtimeStub({ terminalPaneKey: pane, lineCarriesPrompt: false })
    external.requireStore.mockReturnValue(store)
    external.hasLiveTerminalForPaneKey.mockReturnValue(true)
    external.createTerminal.mockResolvedValue({ handle: rig.handle, paneKey: pane })
    external.getTerminalHandleForPaneKey.mockReturnValue(rig.handle)
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
      expect(monitor?.claudeRunningNonAgentTask).toBe(true)
      Object.assign(row, monitor?.payload, {
        claudeRunningNonAgentTask: monitor?.claudeRunningNonAgentTask
      })
    }
    const counters = { visits: 0, projections: 0, snapshots: 0, normalizations: 0, sorts: 0 }
    Object.assign(rig.runtime, {
      getAgentStatusSnapshotFn: () => {
        counters.snapshots += population
        return Array.from({ length: population }, (_, n) => ({
          paneKey: `unrelated-${n}`,
          state: 'working',
          agentType: agent,
          receivedAt: 1,
          connectionId: null
        }))
      }
    })
    const runtime = Object.assign(new OrcaRuntimeService(store), external, {
      getTerminalWorktreeIdForHandle: () => automation.workspaceId,
      getPtyExecutionHostMetadata: () => ({ executionHostId: 'local' }),
      getTerminalPromptRequestBinding: rig.runtime.getTerminalPromptRequestBinding.bind(
        rig.runtime
      ),
      getTerminalPtyIdForHandle: rig.runtime.getTerminalPtyIdForHandle.bind(rig.runtime),
      getTerminalPaneKey: rig.runtime.getTerminalPaneKey.bind(rig.runtime),
      getAgentStatusRowsForPane: () => [row],
      readObservedAgentStatusPaneIdentityFn: () => ({
        kind: 'observed',
        terminalHandle: rig.handle,
        processIncarnation: binding.processIncarnation,
        dispatchId: null
      }),
      readLaunchedAgentForeground: rig.runtime.readLaunchedAgentForeground.bind(rig.runtime),
      subscribeToTerminalData: rig.runtime.subscribeToTerminalData.bind(rig.runtime),
      sendTerminalAgentPrompt: rig.runtime.sendTerminalAgentPrompt.bind(rig.runtime),
      // The separate controller reports initial composer readiness; semantic input still uses the real PTY writer.
      waitForFreshWorkerComposer: vi.fn(async () => ({
        handle: rig.handle,
        condition: 'tui-idle' as const,
        satisfied: true,
        status: 'running' as const,
        exitCode: null
      })),
      waitForTerminal: vi.fn(async () => ({ satisfied: true })),
      showManagedWorktree: async () => ({ displayName: 'Audit' })
    })
    let service: AutomationService
    service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      terminalObserver: createRuntimeAutomationRunTerminalObserver(runtime),
      headlessDispatcher: async (request) => {
        const observation = service.reserveTerminalRun(request.run)
        try {
          const { terminalHandle: _handle, ...launch } = await launchHeadlessAutomationAgent(
            runtime,
            { ...request, observation, runs: store.listAutomationRuns(automation.id) }
          )
          return launch
        } finally {
          observation?.deliverySettled()
        }
      }
    })
    const normalizeStatus = statusProjection.mapExplicitAgentStateToRuntimeTerminalStatus
    vi.spyOn(statusProjection, 'mapExplicitAgentStateToRuntimeTerminalStatus').mockImplementation(
      (state) => {
        counters.normalizations += 1
        return normalizeStatus(state)
      }
    )
    const subscribe = vi.spyOn(transcripts, 'subscribeNativeChatTranscript')
    const incremental = vi.spyOn(transcriptReaders, 'readIncrementalTranscriptMessages')
    const decoder = vi.spyOn(transcriptDecoders, 'nativeChatLineDecoderForAgent')
    const openRead = vi.spyOn(transcriptFs, 'openTranscriptReadStream')
    const listRuns = store.listAutomationRuns.bind(store)
    const listDefinitions = store.listAutomations.bind(store)
    vi.spyOn(store, 'listAutomationRuns').mockImplementation((id) => {
      const rows = listRuns(id)
      counters.visits += rows.length
      return rows
    })
    vi.spyOn(store, 'listAutomations').mockImplementation(() => {
      const rows = listDefinitions()
      counters.visits += rows.length
      return rows
    })
    const populationOf = (rows: unknown[]): number => {
      const first = rows[0]
      return first &&
        typeof first === 'object' &&
        ('automationId' in first ||
          ('rrule' in first && 'agentId' in first) ||
          ('paneKey' in first && 'agentType' in first))
        ? rows.length
        : 0
    }
    const filter = Array.prototype.filter,
      map = Array.prototype.map,
      sort = Array.prototype.sort,
      toSorted = Array.prototype.toSorted
    vi.spyOn(Array.prototype, 'filter').mockImplementation(function (
      this: unknown[],
      predicate,
      thisArg
    ) {
      counters.visits += populationOf(this)
      return filter.call(this, predicate, thisArg)
    })
    vi.spyOn(Array.prototype, 'map').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg
    ) {
      counters.projections += populationOf(this)
      return map.call(this, callback, thisArg)
    })
    vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], compare) {
      counters.sorts += populationOf(this)
      return sort.call(this, compare)
    })
    vi.spyOn(Array.prototype, 'toSorted').mockImplementation(function (this: unknown[], compare) {
      counters.sorts += populationOf(this)
      return toSorted.call(this, compare)
    })
    const advance = vi.spyOn(store, 'advanceAutomationNextRun')
    const flush = store.flushPendingOrThrowAsync.bind(store)
    const lostAck = Promise.withResolvers<void>()
    let stalled = false
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockImplementation(async (options) => {
      if (
        !stalled &&
        listRuns(automation.id).filter((run) => run.status === 'dispatched').length === 4
      ) {
        stalled = true
        await lostAck.promise
      }
      await flush(options)
    })
    // Counters are armed before the first trigger and never reset through persisted delivery.
    try {
      for (let cycle = 0; cycle < 4; cycle += 1) {
        const scheduled = cycle === 1 || cycle === 2
        const now = Date.now.bind(Date)
        const offset =
          listDefinitions().find((entry) => entry.id === automation.id)!.nextRunAt - now()
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
              listRuns(automation.id).filter((run) => run.status === 'dispatched')
            ).toHaveLength(cycle + 1),
          { timeout: 5000 }
        )
        if (cycle === 0) {
          expect(queued.shift()).toBe('same prompt')
          appendFileSync(path, answer('earlier-manual'))
          row.state = 'done'
        }
        if (cycle === 3) {
          lostAck.reject(new Error('lost dispatched acknowledgement'))
        }
        if (scheduled) {
          await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(cycle))
        } else if (cycle === 3) {
          expect(await settled).toBeInstanceOf(Error)
        } else {
          expect(await settled).toMatchObject({ status: 'dispatched' })
        }
        clock?.mockRestore()
        for (const run of listRuns(automation.id)) {
          expect(run).toMatchObject({
            status: 'dispatched',
            terminalPaneKey: pane,
            terminalPtyId: binding.ptyId,
            outputSnapshot: null
          })
          expect(readAutomationRunReceipt(recordStore, run)).toMatchObject({
            kind: 'terminal',
            accepted: true
          })
        }
      }
      expect(external.createTerminal).toHaveBeenCalledOnce()
      expect(queued).toEqual(Array(4).fill('same prompt'))
      expect(rig.writes.filter((data) => data.includes('same prompt'))).toHaveLength(4)
      expect(queued.shift()).toBe('same prompt')
      appendFileSync(path, answer('later-own-input'))
      await service.runInAutomationLane(automation.id, async () => {})
      expect(
        listRuns(automation.id).every(
          (run) => run.status === 'dispatched' && run.outputSnapshot === null
        )
      ).toBe(true)
      expect(runtime.waitForTerminal).not.toHaveBeenCalled()
      expect(subscribe).not.toHaveBeenCalled()
      expect(incremental).not.toHaveBeenCalled()
      expect(decoder).not.toHaveBeenCalled()
      expect(openRead).not.toHaveBeenCalled()
      expect(counters.visits).toBeGreaterThan(0)
      expect(counters.snapshots).toBeGreaterThan(0)
      console.info('whole-delivery-cost', agent, population, {
        ...counters,
        transcriptSubscriptions: subscribe.mock.calls.length,
        historyDecoders: decoder.mock.calls.length,
        incrementalReads: incremental.mock.calls.length,
        rawReads: openRead.mock.calls.length
      })
      expect(
        counters.visits +
          counters.projections +
          counters.snapshots +
          counters.normalizations +
          counters.sorts
      ).toBeLessThan(1500 * population)
      if (population === 1000) {
        const small = metrics.get(agent)!
        for (const key of [
          'visits',
          'projections',
          'snapshots',
          'normalizations',
          'sorts'
        ] as const) {
          expect(counters[key]).toBeLessThanOrEqual(12 * small[key] + 100)
        }
      } else {
        metrics.set(agent, { ...counters })
      }
      if (agent === 'claude') {
        expect(monitor?.claudeRunningNonAgentTask).toBe(true)
      } else {
        expect(row.subagents[0]?.state).toBe('working')
      }
      // Positive control: the unchanged ordinary transcript consumer still reads history and appends.
      const initial = vi.fn(),
        appended = vi.fn()
      const consumer = await transcripts.subscribeNativeChatTranscript({
        agent,
        sessionId: 'session',
        filePath: path,
        initialLimit: 10,
        onInitialSnapshot: initial,
        onAppend: appended,
        debounceMs: 0,
        reconciliationIntervalMs: 10
      })
      try {
        await vi.waitFor(() => expect(initial).toHaveBeenCalled())
        expect(initial.mock.calls[0]?.[0].length).toBeGreaterThan(0)
        appendFileSync(path, answer('ordinary-consumer'))
        await vi.waitFor(() => expect(appended).toHaveBeenCalled())
        expect(incremental).toHaveBeenCalled()
        expect(decoder).toHaveBeenCalled()
        expect(openRead).toHaveBeenCalled()
        console.info('ordinary-transcript-control', agent, population, {
          subscriptions: subscribe.mock.calls.length,
          decoders: decoder.mock.calls.length,
          incrementalReads: incremental.mock.calls.length,
          rawReads: openRead.mock.calls.length
        })
      } finally {
        consumer.unsubscribe()
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
      getTerminalWorktreeIdForHandle: () => automation.workspaceId,
      getPtyExecutionHostMetadata: () => ({ executionHostId: 'local' }),
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
