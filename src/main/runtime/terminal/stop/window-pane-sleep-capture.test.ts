import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { windowSaveKeepingMainSleepRecords } from '../../../persistence/window-save-sleep-records'
import { completionHistoryContains } from '../../../../shared/agent-status/lifecycle/agent-completion-history'
import { stopRendererOwnedPty } from '../../../ipc/pty/ipc/renderer-kill'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { ALL_RPC_METHODS } from '../../rpc/methods/rpc-method-registry'
import { DESKTOP_RPC_CALLER } from '../../rpc/rpc-caller-identity'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  paneSleepAgentStatus,
  displayOnlyPaneSleepFromEntry
} from '../../../../shared/agent-session/lifecycle/pane-sleep-agent-status'
import { ptyIncarnationById, ptyOwnership } from '../../../ipc/pty/provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../../ipc/pty/provider/registry'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import {
  openTopologyStore,
  reopenTopologyStore,
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID as WORKSPACE
} from '../../../persistence/terminal-topology/terminal-topology-profile-fixture'
import { withBoundPane } from '../../orca-runtime-tests/bind-first-pane.test-fixture'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `sleep-tab:${LEAF}`
const PTY = 'window-sleep-pty'
const originalProvider = getLocalPtyProvider()
afterEach(() => {
  setLocalPtyProvider(originalProvider)
  ptyOwnership.delete(PTY)
  ptyIncarnationById.delete(PTY)
})

it.each(['unchanged', 'closed', 'rebound', 'new-turn'] as const)(
  'admits an exact desktop capture at durable commit in shipped mode: %s',
  async (change) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-window-sleep-'))
    let store = await openTopologyStore(directory, emptyTerminalSessionProfile())
    const runtime = new OrcaRuntimeService(store)
    try {
      // Spawn commits its new binding before acknowledging the renderer; no window save is needed.
      store.setWorkspaceSession(
        withBoundPane(store.getWorkspaceSession(), {
          worktreeId: WORKSPACE,
          tabId: 'sleep-tab',
          leafId: LEAF,
          ptyId: 'prior-pty'
        })
      )
      await store.persistPtyBinding({
        worktreeId: WORKSPACE,
        tabId: 'sleep-tab',
        leafId: LEAF,
        ptyId: PTY,
        incarnationId: 'inc-current'
      })
      runtime.registerPty(PTY, WORKSPACE, null, {
        tabId: 'sleep-tab',
        leafId: LEAF,
        incarnationId: 'inc-current'
      })
      ptyOwnership.set(PTY, 'local')
      ptyIncarnationById.set(PTY, 'inc-current')
      let row: AgentStatusIpcPayload = {
        paneKey: PANE,
        tabId: 'sleep-tab',
        worktreeId: WORKSPACE,
        state: 'done',
        prompt: 'finished task',
        agentType: 'custom-cli',
        connectionId: null,
        receivedAt: 20,
        stateStartedAt: 20
      }
      Object.assign(runtime, { getAgentProviderSessionSnapshotFn: () => [row] })
      const observed = Promise.withResolvers<void>()
      // Fresh inspection may take nonzero time; its elapsed duration is not a stale-cache lease.
      const inspectProcess = vi.fn(async () => {
        observed.resolve()
        return {
          foregroundProcess: 'custom-cli',
          hasChildProcesses: true,
          foregroundObservation: {
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: 'non-shell',
            processName: 'custom-cli',
            ptyId: PTY,
            ptyIncarnationId: 'inc-current',
            authorityGeneration: 'authority-current',
            observationEpoch: 2,
            capturedAgeMs: 12
          }
        }
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the process inspection port is reached.
      setLocalPtyProvider({ inspectProcess } as unknown as IPtyProvider)
      const record = displayOnlyPaneSleepFromEntry(
        { ...row, updatedAt: 20, stateHistory: [] },
        WORKSPACE,
        30
      )
      const command = {
        type: 'sleep',
        workspace: WORKSPACE,
        tabId: 'sleep-tab',
        recordOnly: true,
        paneKeys: [PANE],
        records: [record],
        expectedRecords: [],
        expectedAbsentPaneKeys: [PANE],
        expectedTargets: [
          {
            paneKey: PANE,
            ptyId: PTY,
            ptyIncarnationId: 'inc-current',
            authorityGeneration: 'authority-current',
            sourceUpdatedAt: 20
          }
        ]
      }
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const durable = store.runDurableMutation.bind(store)
      vi.spyOn(store, 'runDurableMutation').mockImplementationOnce(async (mutate) => {
        entered.resolve()
        await release.promise
        return durable(mutate)
      })
      const remoteReply = await new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS }).dispatch(
        {
          id: 'paired-capture',
          authToken: 'paired-capture',
          method: 'layout.apply',
          params: { command }
        },
        {
          caller: { kind: 'paired-device', deviceId: 'phone' },
          clientKind: 'runtime',
          connectionId: 'phone'
        }
      )
      expect(remoteReply).toMatchObject({ ok: true, result: { ok: false, code: 'host_not_owned' } })
      expect(inspectProcess).not.toHaveBeenCalled()
      const pending = new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS }).dispatch(
        {
          id: 'desktop-ipc',
          authToken: 'desktop-ipc',
          method: 'layout.apply',
          params: { command }
        },
        { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime', connectionId: 'desktop-renderer:73:1' }
      )
      await observed.promise
      await entered.promise
      if (change === 'closed') {
        store.setWorkspaceSession({
          ...store.getWorkspaceSession(),
          tabsByWorktree: {},
          terminalLayoutsByTabId: {}
        })
      } else if (change === 'rebound') {
        await store.persistPtyBinding({
          worktreeId: WORKSPACE,
          tabId: 'sleep-tab',
          leafId: LEAF,
          ptyId: 'replacement',
          incarnationId: 'inc-replacement'
        })
      } else if (change === 'new-turn') {
        row = { ...row, state: 'working', receivedAt: 40, stateStartedAt: 40 }
      }
      release.resolve()
      const reply = await pending
      expect(inspectProcess).toHaveBeenCalledWith(PTY, {
        foregroundOnly: true,
        expectedIncarnationId: 'inc-current'
      })
      expect(reply.ok).toBe(true)
      if (change === 'unchanged') {
        expect(reply).toMatchObject({ result: { ok: true, result: { slept: [PANE] } } })
        const shutdown = vi.fn(async () => true)
        await stopRendererOwnedPty(
          {
            store,
            runtime,
            getLocalPtyProviderStartupPromise: () => undefined,
            shutdownProviderAndDetectExit: shutdown,
            rememberSyntheticKillExit: vi.fn(),
            sendPtyExitToRenderer: vi.fn()
          },
          {
            id: PTY,
            keepHistory: true,
            sleepCondition: { workspace: WORKSPACE, target: command.expectedTargets[0], record }
          }
        )
        expect(shutdown).toHaveBeenCalledExactlyOnceWith(expect.anything(), PTY, {
          immediate: true,
          keepHistory: true
        })
        runtime.onPtyExit(PTY, 0, WORKSPACE)
        store.setWorkspaceSession(
          windowSaveKeepingMainSleepRecords(
            store.getWorkspaceSession(),
            { ...store.getWorkspaceSession(), sleepingAgentSessionsByPaneKey: undefined },
            'set'
          )
        )
      }
      store = await reopenTopologyStore(store, directory)
      expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[PANE]).toEqual(
        change === 'unchanged' ? record : undefined
      )
      if (change === 'unchanged') {
        const oldWindow = store.getWorkspaceSession()
        await store.persistPtyBinding({
          worktreeId: WORKSPACE,
          tabId: 'sleep-tab',
          leafId: LEAF,
          ptyId: PTY,
          incarnationId: 'inc-woken'
        })
        const woken = new OrcaRuntimeService(store)
        woken.registerPty(PTY, WORKSPACE, null, {
          tabId: 'sleep-tab',
          leafId: LEAF,
          incarnationId: 'inc-woken'
        })
        woken.recordHookStatusResume({
          ...row,
          state: 'working',
          prompt: 'new task after wake',
          receivedAt: 40,
          stateStartedAt: 40
        })
        await woken['hookStatusResumeWrites']
        expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[PANE]).toBeUndefined()
        woken.onPtyExit(PTY, 0, WORKSPACE)
        store.setWorkspaceSession(
          windowSaveKeepingMainSleepRecords(store.getWorkspaceSession(), oldWindow, 'set')
        )
        store = await reopenTopologyStore(store, directory)
        expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[PANE]).toBeUndefined()
      }
    } finally {
      await store.freezeWritesAsync()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.each(['working', 'done'] as const)(
  'preserves a %s agent through main restart, sleep capture and saved-session reload',
  async (state) => {
    const { AgentHookServer } = await import('../../../agent-hooks/server/agent-hook-server')
    const { buildBody, postHookEvent } =
      await import('../../../agent-hooks/server/testing/server.test-fixtures')
    const directory = mkdtempSync(join(tmpdir(), 'orca-sleep-previous-end-'))
    let store = await openTopologyStore(directory, emptyTerminalSessionProfile())
    let server = new AgentHookServer()
    try {
      await server.start({ env: 'production', userDataPath: directory })
      const send = (payload: Record<string, unknown>) =>
        postHookEvent(
          server,
          buildBody(
            { session_id: 'owned-session', ...payload },
            { paneKey: PANE, tabId: 'sleep-tab', worktreeId: WORKSPACE }
          )
        )
      await send({ hook_event_name: 'UserPromptSubmit', prompt: 'first task' })
      await send({ hook_event_name: 'Stop', last_assistant_message: 'First task complete.' })
      const finished = server.getStatusSnapshotForPane(PANE)[0]
      if (state === 'working') {
        await send({ hook_event_name: 'UserPromptSubmit', prompt: 'second task' })
        expect(server.getStatusSnapshotForPane(PANE)[0].previousCompletion).toMatchObject({
          kind: 'previous',
          end: { state: 'done', startedAt: finished.stateStartedAt },
          lastAssistantMessage: 'First task complete.'
        })
      }
      server.flushStatusPersistSync()
      server.stop()
      server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: directory })
      const restored = server.getStatusSnapshotForPane(PANE)[0]
      expect(restored.state).toBe(state)
      expect(restored.restoredUnconfirmed).toBe(state === 'working' ? true : undefined)
      store.setWorkspaceSession(
        withBoundPane(store.getWorkspaceSession(), {
          worktreeId: WORKSPACE,
          tabId: 'sleep-tab',
          leafId: LEAF,
          ptyId: PTY
        })
      )
      const runtime = new OrcaRuntimeService(store)
      runtime.registerPty(PTY, WORKSPACE, null, { tabId: 'sleep-tab', leafId: LEAF })
      Object.assign(runtime, {
        getAgentProviderSessionSnapshotFn: () => server.getStatusSnapshot()
      })
      const capture = await runtime['sleepResumeRecords'].capture(WORKSPACE, new Set([PTY]))
      await runtime['sleepResumeRecords'].prepare(WORKSPACE, capture, () => true)
      store = await reopenTopologyStore(store, directory)
      const record = store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[PANE]
      if (!record) {
        throw new Error('Missing slept record after reload')
      }
      const row = paneSleepAgentStatus(record)
      expect(row).toMatchObject({
        state: 'done',
        prompt: state === 'working' ? 'second task' : 'first task',
        stateStartedAt: restored.stateStartedAt
      })
      if (!row) {
        throw new Error('Missing projected sleeping row')
      }
      if (state === 'working') {
        expect(row.sessionBoundary).toBe(true)
        expect(row.stateHistory).toMatchObject([
          { state: 'done', prompt: 'first task', startedAt: finished.stateStartedAt }
        ])
        expect(row.lastCompletedAssistantMessage).toBe('First task complete.')
        expect(record.completion?.kind).toBe('previous')
        expect(
          completionHistoryContains(row, {
            stateStartedAt: finished.stateStartedAt,
            prompt: finished.prompt,
            turnEndedAt: finished.turnEndedAt,
            turnCompletedAt: finished.turnCompletedAt
          })
        ).toBe(true)
      } else {
        expect(row.lastAssistantMessage).toBe('First task complete.')
        expect(record.completion?.kind).toBe('current')
        expect(row.sessionBoundary).toBeUndefined()
        expect(row.stateHistory).toEqual([])
      }
    } finally {
      server.stop()
      await store.freezeWritesAsync()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
