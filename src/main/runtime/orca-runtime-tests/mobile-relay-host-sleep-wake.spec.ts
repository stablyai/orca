import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import { TEST_WINDOW_ID, store } from '../orca-runtime-test-fixtures.spec'
import { RpcDispatcher } from '../rpc/dispatcher'
import { MOBILE_RELAY_HOSTS_METHODS } from '../rpc/methods/mobile-relay-hosts'

const SERVER = 'runtime:env-1'
const SERVER_WORKTREE = 'server-repo::/srv/orca'

/** A desktop whose renderer may or may not be open, holding slept agents in `sleptOnHost`'s partition. */
function desktop(options: { windowOpen: boolean; sleptOnHost?: string }) {
  const sleepWorktree = vi.fn()
  const resumeSleepingAgents = vi.fn()
  const getWorkspaceSession = (hostId: string) => ({
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey:
      hostId === options.sleptOnHost
        ? {
            'tab-1:leaf-1': {
              paneKey: 'tab-1:leaf-1',
              tabId: 'tab-1',
              worktreeId: SERVER_WORKTREE,
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'session-1' },
              prompt: 'test',
              state: 'done',
              capturedAt: 1,
              updatedAt: 1,
              origin: 'worktree-sleep'
            }
          }
        : {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store with one partitioned session reader.
  const runtime = new OrcaRuntimeService({ ...store, getWorkspaceSession } as never)
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree,
    resumeSleepingAgents,
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  electronMocks.BrowserWindow.fromId.mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only isDestroyed.
    (options.windowOpen ? { isDestroyed: () => false } : null) as never
  )
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.markGraphReady(TEST_WINDOW_ID)
  const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_RELAY_HOSTS_METHODS })
  // The desktop's configured servers, as its settings list them.
  const mobileRelayHosts = {
    list: () => ({
      hosts: [{ hostId: SERVER, label: 'VM', health: 'available', relay: 'ready' } as const]
    }),
    worktrees: async () => ({ worktrees: null })
  }
  // The phone's socket path, which is what hands the handlers the desktop's servers.
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      { id: 'request-1', authToken: 'token', method, params },
      (reply) => replies.push(reply),
      { mobileRelayHosts }
    )
    return JSON.parse(replies[0] ?? 'null')
  }
  return { call, sleepWorktree, resumeSleepingAgents }
}

describe('a phone sleeping and waking a server workspace through its desktop', () => {
  it("runs the desktop renderer's sleep for the server's workspace", async () => {
    const { call, sleepWorktree } = desktop({ windowOpen: true })

    const response = await call('mobileRelay.hosts.sleepWorktree', {
      hostId: SERVER,
      worktreeId: SERVER_WORKTREE
    })

    expect(response).toMatchObject({ ok: true, result: { worktreeId: SERVER_WORKTREE } })
    expect(sleepWorktree).toHaveBeenCalledWith(SERVER_WORKTREE)
  })

  it('asks the desktop renderer, which holds the slept agents, to wake them', async () => {
    const { call, resumeSleepingAgents } = desktop({ windowOpen: true, sleptOnHost: SERVER })

    const response = await call('mobileRelay.hosts.wakeSleepingAgents', {
      hostId: SERVER,
      worktreeId: SERVER_WORKTREE
    })

    expect(response).toMatchObject({ ok: true, result: { sleepingAgentWake: 'requested' } })
    expect(resumeSleepingAgents).toHaveBeenCalledWith(SERVER_WORKTREE)
  })

  it("says nothing could wake them with the window closed, reading that server's records", async () => {
    const onServer = desktop({ windowOpen: false, sleptOnHost: SERVER })
    const elsewhere = desktop({ windowOpen: false, sleptOnHost: 'local' })
    const params = { hostId: SERVER, worktreeId: SERVER_WORKTREE }

    expect(await onServer.call('mobileRelay.hosts.wakeSleepingAgents', params)).toMatchObject({
      result: { sleepingAgentWake: 'unsupported-headless' }
    })
    expect(await elsewhere.call('mobileRelay.hosts.wakeSleepingAgents', params)).toMatchObject({
      result: { sleepingAgentWake: 'not-applicable' }
    })
    expect(onServer.resumeSleepingAgents).not.toHaveBeenCalled()
  })

  it("refuses a target that is not one of the desktop's configured servers", async () => {
    const { call, sleepWorktree, resumeSleepingAgents } = desktop({ windowOpen: true })

    for (const hostId of ['local', 'runtime:removed']) {
      const params = { hostId, worktreeId: SERVER_WORKTREE }
      expect(await call('mobileRelay.hosts.sleepWorktree', params)).toMatchObject({ ok: false })
      expect(await call('mobileRelay.hosts.wakeSleepingAgents', params)).toMatchObject({
        ok: false
      })
    }
    expect(sleepWorktree).not.toHaveBeenCalled()
    expect(resumeSleepingAgents).not.toHaveBeenCalled()
  })
})
