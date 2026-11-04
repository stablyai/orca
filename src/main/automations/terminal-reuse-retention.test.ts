import { mkdtempSync, rmSync } from 'node:fs'
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
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { launchHeadlessAutomationAgent } from './headless-automation-agent-launch'
import { AutomationService } from './service'
import { readAutomationRunReceipt } from './automation-run-receipt'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
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
        ...(key === pane ? row : { state: 'done' }),
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
