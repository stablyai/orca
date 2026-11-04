import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
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
import { createRuntimeAutomationService } from './runtime-automation-service'
import {
  attachingRendererViewPtys,
  visibleRendererPtys
} from '../ipc/pty/delivery/visibility-state'
import { getAutomationRunOperations } from '../persistence/loading-store/automation-persistence'
import { AUTOMATION_AGENT_CALLER, automationRunOperationId } from './automation-run-operation'
import { rpcCallerOperationKey } from '../runtime/rpc/rpc-caller-identity'
import { createAutomationTerminalOwnership } from '../../renderer/src/lib/automation-terminal-ownership'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { useAppStore } from '../../renderer/src/store'
import { singlePaneLayoutSnapshot } from '../../renderer/src/store/slices/terminal-helpers'
import { createStore as createRendererStore } from 'zustand/vanilla'
import { isAgentLaunchResult } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeCodexEvent } from '../../shared/agent-hook-listener/providers/codex-events'
import { RUN_TERMINAL_GRACE_MS } from './headless-run-terminal-retention'

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
const realNow = Date.now
const retentionNow = () => vi.getMockedSystemTime()?.getTime() ?? realNow()
const directories: string[] = []
afterEach(async () => {
  visibleRendererPtys.clear()
  attachingRendererViewPtys.clear()
  vi.useRealTimers()
  setAgentLaunchRecordStore(null)
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function setup() {
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
  const control = {
    row: normalize('UserPromptSubmit', 'seed-turn'),
    shell: false,
    wakeupPending: false,
    beforeClose: () => {}
  }
  const stopped: string[] = []
  const close = vi.fn(async (handle: string, options: { beforeAction: () => void }) => {
    await Promise.resolve()
    control.beforeClose()
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
    resolveManagedTerminalWorkspaceTarget:
      OrcaRuntimeService.prototype.resolveManagedTerminalWorkspaceTarget,
    getTerminalWorktreeIdForHandle: () => automation.workspaceId,
    getPtyExecutionHostMetadata: () => ({ executionHostId: 'local' }),
    getTerminalPromptRequestBinding: rig.runtime.getTerminalPromptRequestBinding.bind(rig.runtime),
    getTerminalPaneKey: () => pane,
    getTerminalPtyIdForHandle: (handle: string) =>
      handle === rig.handle ? (stopped.includes(handle) ? null : binding.ptyId) : `pty:${handle}`,
    getTerminalProcessIncarnation: (handle: string) =>
      handle === rig.handle ? binding.processIncarnation : 'sibling',
    getAgentStatusRowsForPane: (key: string) => [
      {
        ...(key === pane ? control.row : { state: 'done' }),
        claudeTaskWakeupPending: key === pane && control.wakeupPending,
        connectionId: null,
        terminalHandle: key === pane ? rig.handle : key
      }
    ],
    readObservedAgentStatusPaneIdentityFn: (key: string) => ({
      kind: 'observed',
      terminalHandle: key === pane ? rig.handle : key,
      processIncarnation: key === pane ? binding.processIncarnation : 'sibling',
      dispatchId: null
    }),
    readTerminalClientUse: (pty: string) =>
      pty === binding.ptyId ? rig.runtime.readTerminalClientUse(pty) : 'used',
    confirmTerminalShellAlone: vi.fn(async () => control.shell),
    closeTerminal: close,
    sleepTerminalsForWorktree: vi.fn(),
    readLaunchedAgentForeground: rig.runtime.readLaunchedAgentForeground.bind(rig.runtime),
    subscribeToTerminalData: rig.runtime.subscribeToTerminalData.bind(rig.runtime),
    sendTerminalAgentPrompt: rig.runtime.sendTerminalAgentPrompt.bind(rig.runtime),
    waitForTerminal: async () => ({ satisfied: true }),
    showManagedWorktree: async () => ({ displayName: 'Audit' })
  })
  vi.spyOn(Date, 'now').mockImplementation(retentionNow)
  const opened = vi.fn<OrcaRuntimeService['openedAgentSessionRecordStore']>(() => records)
  Object.assign(runtime, {
    events: new EventEmitter(),
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    openedAgentSessionRecordStore: opened
  })
  const service = createRuntimeAutomationService({ store, runtime, headless: false })
  service.setWebContents(
    Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
  )
  service.setRendererReady()
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
    await service.runInAutomationLane(automation.id, async () => {})
  }
  return {
    store,
    automation,
    rig,
    pane,
    binding,
    normalize,
    control,
    close,
    stopped,
    records,
    opened,
    external,
    runtime,
    service,
    advance,
    queued,
    consumed
  }
}

it('retains repeated delivered input through old-turn Done until the live CLI consumes it and exits', async () => {
  const {
    store,
    automation,
    rig,
    pane,
    binding,
    normalize,
    control,
    close,
    stopped,
    records,
    external,
    runtime,
    service,
    advance,
    queued,
    consumed
  } = await setup()
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
    const idleTimers = vi.getTimerCount()
    service.start()
    const runningTimers = vi.getTimerCount()
    expect(runningTimers - idleTimers).toBe(2)
    service.start()
    expect(vi.getTimerCount()).toBe(runningTimers)
    service.stop()
    expect(vi.getTimerCount()).toBe(idleTimers)
    service.start()
    expect(vi.getTimerCount()).toBe(runningTimers)
    await advance(RUN_TERMINAL_GRACE_MS + 60_000)
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
    await advance(60_000)
    expect(close).not.toHaveBeenCalled()
    control.row = normalize('Stop', 'seed-turn')
    expect(control.row.state).toBe('done')
    await advance(60_000)
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
    await advance(60_000)
    expect(close).not.toHaveBeenCalled()
    store.updateAutomationRun({
      runId: starting.id,
      status: 'dispatch_failed',
      terminalPaneKey: null,
      terminalPtyId: null
    })
    // The native boundary later consumes each accepted prompt once; no result is invented from that simulation.
    for (const turn of ['one', 'two']) {
      control.row = normalize('UserPromptSubmit', turn)
      consumed.push(queued.shift()!)
      await advance(60_000)
      expect(close).not.toHaveBeenCalled()
      control.row = normalize('Stop', turn)
    }
    expect(consumed).toEqual(['seed', 'queued one', 'queued two'])
    expect(queued).toEqual([])
    // A positive exit/shell verdict permits cleanup, subject to the actual final-boundary recheck.
    control.shell = true
    control.beforeClose = () => {
      control.row = normalize('UserPromptSubmit', 'woken-turn')
    }
    await advance(60_000)
    expect(close).toHaveBeenCalledOnce()
    expect(stopped).toEqual([])
    expect(
      store.listAutomationRuns(automation.id).find((run) => run.id === newest.id)?.terminalPtyId
    ).toBe(binding.ptyId)
    control.beforeClose = () => {}
    control.row = normalize('Stop', 'woken-turn')
    await advance(60_000)
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

it('preserves the ordinary renderer takeover and history even after registry delivery into that pane', async () => {
  const h = await setup()
  const { tabId, leafId } = parsePaneKey(h.pane)!
  const closeTab = vi.fn()
  const renderer = createRendererStore(() => ({
    ...useAppStore.getInitialState(),
    activeWorktreeId: 'elsewhere',
    activeTabId: 'elsewhere',
    activeTabType: 'terminal' as const,
    tabsByWorktree: {
      [h.automation.workspaceId!]: [
        {
          id: tabId,
          worktreeId: h.automation.workspaceId!,
          ptyId: h.binding.ptyId,
          title: 'Ordinary',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { [tabId]: [h.binding.ptyId] },
    terminalLayoutsByTabId: { [tabId]: singlePaneLayoutSnapshot(leafId, h.binding.ptyId) },
    closeTab
  }))
  const owner = createAutomationTerminalOwnership({
    store: renderer,
    worktreeId: h.automation.workspaceId!,
    tabId,
    paneKey: h.pane,
    ptyId: h.binding.ptyId,
    tabCreatedAt: 1,
    runtimeKind: 'desktop'
  })
  h.rig.runtime.terminalRunFacts.recordSpawnCommit({
    id: h.binding.ptyId,
    incarnationId: h.binding.processIncarnation
  })
  const releaseView = h.rig.runtime.registerRawTerminalViewSubscriber(h.binding.ptyId)
  renderer.setState({ activeWorktreeId: h.automation.workspaceId!, activeTabId: tabId })
  expect(h.runtime.readTerminalClientUse(h.binding.ptyId)).toBe('used')
  renderer.setState({ activeWorktreeId: 'elsewhere', activeTabId: 'elsewhere' })
  releaseView()
  expect(h.runtime.readTerminalClientUse(h.binding.ptyId)).toBe('unused')
  await expect(owner.finalize({ preservePane: false })).resolves.toBeNull()
  expect(closeTab).not.toHaveBeenCalled()
  const ordinary = h.store.createAutomationRun(h.automation, Date.now(), 'manual')
  h.store.updateAutomationRun({
    runId: ordinary.id,
    status: 'completed',
    workspaceId: h.automation.workspaceId,
    sessionKind: 'terminal',
    terminalPaneKey: h.pane,
    terminalPtyId: h.binding.ptyId
  })
  h.control.row = h.normalize('Stop', 'ordinary-turn')
  h.control.shell = true
  // Other ordinary panes count toward keep-three even though this owner cannot dispose them.
  addSiblings(h)
  vi.useFakeTimers()
  h.service.start()
  try {
    await h.advance(RUN_TERMINAL_GRACE_MS + 120_000)
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(h.close).not.toHaveBeenCalled()
    // Reuse uses the real writer under the controlled clock without disposing its watcher.
    const delivery = h.service.runNow(h.automation.id)
    await vi.advanceTimersByTimeAsync(5000)
    const sent = await delivery
    expect(sent.error).toBeNull()
    expect(sent).toMatchObject({
      status: 'dispatched',
      terminalPaneKey: h.pane,
      terminalPtyId: h.binding.ptyId
    })
    expect(readAutomationRunReceipt(h.records, sent)).toMatchObject({
      kind: 'terminal',
      accepted: true
    })
    expect(h.external.createTerminal).not.toHaveBeenCalled()
    expect(h.queued).toEqual(['seed'])
    expect(h.rig.writes.filter((write) => write.includes('\x1b[200~'))).toHaveLength(1)
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    // Missing live resolution must not let the host forget another owner's links either.
    const getPty = vi.spyOn(h.runtime, 'getTerminalPtyIdForHandle').mockReturnValue(null)
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    getPty.mockRestore()
    expect(h.close).not.toHaveBeenCalled()
    expect(
      h.store.listAutomationRuns(h.automation.id).find((run) => run.id === ordinary.id)
    ).toMatchObject({ terminalPaneKey: h.pane, terminalPtyId: h.binding.ptyId })
    expect(
      h.store.listAutomationRuns(h.automation.id).find((run) => run.id === sent.id)
    ).toMatchObject({
      status: 'dispatched',
      terminalPaneKey: h.pane,
      terminalPtyId: h.binding.ptyId
    })
  } finally {
    h.service.stop()
  }
})

function addSiblings(h: Awaited<ReturnType<typeof setup>>) {
  for (let n = 0; n < 3; n += 1) {
    const key = `${randomUUID()}:${randomUUID()}`
    const run = h.store.createAutomationRun(h.automation, Date.now() + n + 1, 'manual')
    h.store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      workspaceId: 'sibling-workspace',
      terminalPaneKey: key,
      terminalPtyId: `pty:${key}`,
      sessionKind: 'terminal'
    })
  }
}

it('rederives creator authority, local current visibility and final-boundary revocation without acquiring from delivery', async () => {
  const h = await setup()
  const seed = await h.service.runNow(h.automation.id)
  const sent = await h.service.runNow(h.automation.id)
  expect(h.external.createTerminal).toHaveBeenCalledOnce()
  expect(h.queued).toEqual(['seed', 'seed'])
  h.control.row = h.normalize('Stop', 'old-turn')
  h.control.shell = true
  addSiblings(h)
  const drain = () => h.service.releaseFinishedRunTerminals!()
  const links = () => h.store.listAutomationRuns(h.automation.id).find((run) => run.id === sent.id)
  try {
    visibleRendererPtys.add(h.binding.ptyId)
    await expect(drain()).resolves.toBe(0)
    visibleRendererPtys.delete(h.binding.ptyId)
    attachingRendererViewPtys.set(h.binding.ptyId, { views: 1, skippedHide: false })
    await expect(drain()).resolves.toBe(0)
    attachingRendererViewPtys.delete(h.binding.ptyId)
    h.control.wakeupPending = true
    await expect(drain()).resolves.toBe(0)
    h.control.wakeupPending = false
    // Restart/adoption has no proven unused history, even when receipts survived.
    h.rig.runtime.terminalRunFacts.recordSpawnCommit({
      id: h.binding.ptyId,
      incarnationId: 'adopted',
      isReattach: true
    })
    await expect(drain()).resolves.toBe(0)
    h.rig.runtime.terminalRunFacts.recordSpawnCommit({
      id: h.binding.ptyId,
      incarnationId: h.binding.processIncarnation
    })
    h.opened.mockReturnValue(null)
    await expect(drain()).resolves.toBe(0)
    h.opened.mockImplementation(() => {
      throw new Error('record_store_unavailable')
    })
    await expect(drain()).resolves.toBe(0)
    h.opened.mockReturnValue(h.records)
    const read = vi.spyOn(h.records, 'getOperationRow').mockImplementation(() => {
      throw new Error('unreadable_operation')
    })
    await expect(drain()).resolves.toBe(0)
    read.mockRestore()
    const source = getAutomationRunOperations(h.store).state
    const retained = source.automationRuns!
    source.automationRuns = retained.filter((run) => run.id !== seed.id)
    await expect(drain()).resolves.toBe(0)
    source.automationRuns = retained
    expect(links()).toMatchObject({ status: 'dispatched', terminalPaneKey: h.pane })
    expect(h.close).not.toHaveBeenCalled()
    // A newer cross-automation pending owner remains visible to the final check.
    const other = h.store.createAutomation({ ...h.automation, name: 'Other' })
    const newer = h.store.createAutomationRun(other, Date.now() + 100, 'manual')
    h.store.updateAutomationRun({
      runId: newer.id,
      status: 'pending',
      workspaceId: h.automation.workspaceId,
      terminalPaneKey: h.pane,
      terminalPtyId: h.binding.ptyId
    })
    await expect(drain()).resolves.toBe(0)
    h.store.updateAutomationRun({
      runId: newer.id,
      status: 'skipped_precheck',
      terminalPaneKey: null,
      terminalPtyId: null
    })
    // Sources/currentness can change after shell probing, at the actual runtime callback.
    h.control.beforeClose = () => visibleRendererPtys.add(h.binding.ptyId)
    await expect(drain()).resolves.toBe(0)
    expect(h.stopped).toEqual([])
    visibleRendererPtys.delete(h.binding.ptyId)
    h.control.beforeClose = () => h.opened.mockReturnValue(null)
    await expect(drain()).resolves.toBe(0)
    h.opened.mockReturnValue(h.records)
    const incarnation = vi.spyOn(h.runtime, 'getTerminalProcessIncarnation')
    h.control.beforeClose = () => {
      incarnation.mockReturnValue('replacement-incarnation')
    }
    await expect(drain()).resolves.toBe(0)
    incarnation.mockRestore()
    h.control.beforeClose = () => h.service.stop()
    await expect(drain()).resolves.toBe(0)
    expect(h.stopped).toEqual([])
    h.control.beforeClose = () => {}
    await expect(drain()).resolves.toBe(1)
    expect(h.stopped).toEqual([h.rig.handle])
    expect(links()).toMatchObject({
      status: 'dispatched',
      terminalPaneKey: null,
      terminalPtyId: null
    })
    // The dead creator's own stale links may now be forgotten without touching replacements.
    await expect(drain()).resolves.toBe(0)
    expect(
      h.store.listAutomationRuns(h.automation.id).find((run) => run.id === seed.id)
    ).toMatchObject({ terminalPaneKey: null, terminalPtyId: null })
    expect(h.rig.writes.filter((write) => write.includes('\x1b[200~'))).toHaveLength(2)
  } finally {
    h.service.stop()
  }
})

it('ends automatic authority after actual creator history eviction or operation pruning, without pinning delivery', async () => {
  const h = await setup()
  const seed = await h.service.runNow(h.automation.id)
  const sent = await h.service.runNow(h.automation.id)
  h.control.row = h.normalize('Stop', 'old-turn')
  h.control.shell = true
  try {
    const callerKey = rpcCallerOperationKey(AUTOMATION_AGENT_CALLER)
    const operation = automationRunOperationId(seed, 'fresh-launch')
    expect(h.records.getOperationRow(callerKey, operation)?.outcome.status).toBe('succeeded')
    const future = Date.now() + 2 * 24 * 60 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(future)
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(h.records.getOperationRow(callerKey, operation)).not.toBeNull()
    vi.spyOn(Date, 'now').mockImplementation(retentionNow)
    await h.records.admitGlobalOperation({
      callerKey,
      operationId: `${future}-${randomUUID()}`,
      fingerprint: 'prune-control',
      now: future
    })
    expect(h.records.getOperationRow(callerKey, operation)).toBeNull()
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(
      h.store.listAutomationRuns(h.automation.id).find((run) => run.id === sent.id)
    ).toMatchObject({ status: 'dispatched', terminalPaneKey: h.pane })
    expect(h.close).not.toHaveBeenCalled()
    // Normal Store pruning, no pinned seed or artificial Active run.
    for (let n = 0; n < 101; n += 1) {
      const run = h.store.createAutomationRun(h.automation, future + n, 'manual')
      h.store.updateAutomationRun({ runId: run.id, status: 'skipped_precheck' })
    }
    const history = h.store.listAutomationRuns(h.automation.id)
    // Creation prunes existing history to100 before appending its pending row; final publication leaves101 until the next append.
    expect(history).toHaveLength(101)
    expect(history.some((run) => run.id === seed.id || run.id === sent.id)).toBe(false)
    expect(history.every((run) => run.status === 'skipped_precheck')).toBe(true)
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(h.external.createTerminal).toHaveBeenCalledOnce()
    expect(h.rig.writes.filter((write) => write.includes('\x1b[200~'))).toHaveLength(2)
  } finally {
    h.service.stop()
  }
})

it('recognizes actual provisional creation without claiming prompt success and forgets only its replaced old resource', async () => {
  const h = await setup()
  const record = h.records.recordOperationOutcome.bind(h.records)
  const settlement = vi.spyOn(h.records, 'recordOperationOutcome').mockImplementation((args) => {
    if (
      args.outcome.status === 'succeeded' &&
      isAgentLaunchResult(args.outcome.launch) &&
      args.outcome.launch.prompt?.outcome === 'handed-to-terminal'
    ) {
      return Promise.reject(new Error('lost_final_settlement'))
    }
    return record(args)
  })
  try {
    const run = await h.service.runNow(h.automation.id)
    expect(run).toMatchObject({
      status: 'dispatched',
      terminalPaneKey: h.pane,
      terminalPtyId: h.binding.ptyId
    })
    expect(readAutomationRunReceipt(h.records, run)).toMatchObject({
      kind: 'terminal',
      accepted: false,
      launch: { prompt: { outcome: 'unconfirmed' } }
    })
    expect(h.external.createTerminal).toHaveBeenCalledOnce()
    expect(settlement).toHaveBeenCalledTimes(2)
    expect(h.queued).toEqual(['seed'])
    h.control.row = h.normalize('Stop', 'old-turn')
    h.control.shell = true
    const pty = vi.spyOn(h.runtime, 'getTerminalPtyIdForHandle')
    h.control.beforeClose = () => {
      pty.mockReturnValue('replacement-pty')
    }
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(h.stopped).toEqual([])
    expect(
      h.store.listAutomationRuns(h.automation.id).find((row) => row.id === run.id)
    ).toMatchObject({ terminalPaneKey: h.pane, terminalPtyId: h.binding.ptyId })
    // Once the old resource is gone, only its own stale references may be forgotten.
    await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(0)
    expect(h.stopped).toEqual([])
    expect(
      h.store.listAutomationRuns(h.automation.id).find((row) => row.id === run.id)
    ).toMatchObject({ status: 'dispatched', terminalPaneKey: null, terminalPtyId: null })
    expect(h.runtime.getTerminalPtyIdForHandle(h.rig.handle)).toBe('replacement-pty')
    pty.mockRestore()
  } finally {
    h.service.stop()
  }
})

it('bounds provenance and history work under actual timer/drain at N and 10N with a real created positive control', async () => {
  const measurements: { population: number; reads: number; visits: number; snapshots: number }[] =
    []
  for (const population of [10, 100]) {
    const h = await setup()
    await h.service.runNow(h.automation.id)
    await h.service.runNow(h.automation.id)
    h.control.row = h.normalize('Stop', 'old-turn')
    h.control.shell = true
    // A real mixed fleet: only its creator may release the positive resource; ordinary rows never grant ownership.
    for (let n = 0; n < population; n += 1) {
      const automation = h.store.createAutomation({ ...h.automation, name: `Ordinary ${n}` })
      const run = h.store.createAutomationRun(automation, Date.now() + n + 1, 'manual')
      const pane = `${randomUUID()}:${randomUUID()}`
      h.store.updateAutomationRun({
        runId: run.id,
        status: 'completed',
        terminalPaneKey: pane,
        terminalPtyId: `pty:${pane}`
      })
    }
    const source = getAutomationRunOperations(h.store).state
    let visits = 0,
      snapshots = 0
    const observe = (runs: NonNullable<typeof source.automationRuns>) =>
      new Proxy(runs, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            visits += 1
          }
          return Reflect.get(target, key, receiver)
        }
      })
    let current = observe(source.automationRuns!)
    Object.defineProperty(source, 'automationRuns', {
      configurable: true,
      get: () => {
        snapshots += 1
        return current
      },
      set: (runs: NonNullable<typeof source.automationRuns>) => {
        current = observe(runs)
      }
    })
    const read = vi.spyOn(h.records, 'getOperationRow')
    const transcripts = vi.spyOn(h.runtime, 'subscribeToTerminalData')
    const rows = vi.spyOn(h.records, 'listOperationRows')
    vi.useFakeTimers()
    h.service.start()
    try {
      await h.advance(RUN_TERMINAL_GRACE_MS + 120_000)
      await expect(h.service.releaseFinishedRunTerminals!()).resolves.toBe(1)
      expect(h.stopped).toEqual([h.rig.handle])
      expect(transcripts).not.toHaveBeenCalled()
      expect(rows).not.toHaveBeenCalled()
      measurements.push({ population, reads: read.mock.calls.length, visits, snapshots })
    } finally {
      h.service.stop()
      Object.defineProperty(source, 'automationRuns', {
        configurable: true,
        writable: true,
        value: Array.from(current)
      })
      vi.useRealTimers()
      read.mockRestore()
      transcripts.mockRestore()
      rows.mockRestore()
    }
  }
  const [n, tenN] = measurements
  expect(n.reads).toBeGreaterThan(0)
  expect(n.visits).toBeGreaterThan(0)
  expect(tenN.reads).toBeLessThanOrEqual(n.reads * 11)
  expect(tenN.visits).toBeLessThanOrEqual(n.visits * 11)
  expect(tenN.snapshots).toBeLessThanOrEqual(n.snapshots * 11)
  console.info('retention-work', measurements)
})
