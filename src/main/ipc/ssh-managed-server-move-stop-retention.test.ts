import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock(
  '../ssh/ssh-previous-relay-terminals',
  () => import('../ssh/ssh-previous-relay-census-test-double')
)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { withDurableRuntimeStore } from '../runtime/runtime-durable-store-fixture'
import { getSshPtyProvider, getPtyIdsForConnection } from './pty'
import { ptyIncarnationById } from './pty/provider/ownership-state'
import { setCurrentRuntime } from './ssh-ipc-context'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { terminateSshTargetSessions } from './ssh-terminate-sessions'

const { mockSshStore, mockPtyProvider } = mocks
const worktreeId = 'repo::/srv/repo'
const leafId = '11111111-1111-4111-8111-111111111111'
const stoppedShell = 'ssh:ssh-1@@pty2:epoch:1'
const userExitedShell = 'ssh:ssh-1@@pty2:epoch:2'
const repo: Repo = {
  id: 'repo',
  path: '/srv/repo',
  connectionId: 'ssh-1',
  displayName: 'repo',
  badgeColor: 'gray',
  addedAt: 1
}

function sessionWith(ptyIds: Record<string, string>): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: Object.entries(ptyIds).map(([tabId, ptyId], sortOrder) => ({
        id: tabId,
        worktreeId,
        ptyId,
        title: `Terminal ${sortOrder + 1}`,
        customTitle: null,
        color: null,
        sortOrder,
        createdAt: 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(ptyIds).map(([tabId, ptyId]) => [
        tabId,
        {
          root: { type: 'leaf', leafId: `${leafId.slice(0, -1)}${tabId.at(-1)}` },
          activeLeafId: `${leafId.slice(0, -1)}${tabId.at(-1)}`,
          expandedLeafId: null,
          ptyIdsByLeafId: { [`${leafId.slice(0, -1)}${tabId.at(-1)}`]: ptyId }
        }
      ])
    )
  }
}

describe("a move's stop keeps the saved SSH session it is about to convert", () => {
  const harness = createSshIpcHarness(mocks)
  beforeEach(harness.reset)
  afterEach(() => setCurrentRuntime(undefined))

  it('keeps the stopped tab through its real exit, certifies the death, and closes an earlier exit', async () => {
    let session = sessionWith({ 'tab-1': stoppedShell, 'tab-2': userExitedShell })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake supplies the session and repo methods exit retirement reads.
    const store = withDurableRuntimeStore({
      getRepos: () => [repo],
      getRepo: () => repo,
      getWorkspaceSessionHostIds: () => ['ssh:ssh-1'],
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      flushOrThrow: vi.fn()
    }) as never
    const runtime = new OrcaRuntimeService(store)
    for (const [tabId, ptyId] of [
      ['tab-1', stoppedShell],
      ['tab-2', userExitedShell]
    ] as const) {
      const tabLeafId = `${leafId.slice(0, -1)}${tabId.at(-1)}`
      runtime.registerPty(ptyId, worktreeId, 'ssh-1', {
        tabId,
        leafId: tabLeafId,
        incarnationId: `inc-${tabId}`
      })
      ptyIncarnationById.set(ptyId, `inc-${tabId}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a real OrcaRuntimeService.
    setCurrentRuntime(runtime as never)
    mockSshStore.getTarget.mockReturnValue({
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    })
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([stoppedShell])

    // The user's own exit lands before the move stops anything: it closes its tab as always.
    await runtime.onPtyExit(userExitedShell, 0, 'inc-tab-2', { hostExitConfirmed: true })
    expect(session.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual(['tab-1'])

    // The relay reports the stopped shell's real exit while its shutdown is in flight.
    mockPtyProvider.shutdown.mockImplementation(async (ptyId: string) => {
      await runtime.onPtyExit(ptyId, 0, 'inc-tab-1', { hostExitConfirmed: true })
    })
    const stopped: string[] = []
    await terminateSshTargetSessions('ssh-1', {
      intentionalStop: 'replaced',
      onStopped: (ptyId) => stopped.push(ptyId)
    })

    expect(stopped).toEqual([stoppedShell])
    expect(session.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(runtime.getPtyLivenessVerdict(stoppedShell)?.status).toBe('exited')
  }, 120_000)
})
