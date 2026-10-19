// Runs on plain Node, as orcad does: a host with no window raises and clears its own unread flags.
import '../rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { AgentHookServer } from '../../agent-hooks/server'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeStore } from '../runtime-store-contract'
import { RpcDispatcher } from '../rpc/dispatcher'
import type { RpcDispatchStreamingOptions } from '../rpc/dispatcher-stream-options'
import { SESSION_TAB_METHODS } from '../rpc/methods/session-tabs'
import { SIDEBAR_INPUT_METHODS } from '../rpc/methods/sidebar-inputs'
import { requireSwitchedOn } from './require-switched-on'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime-client-capabilities'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../../shared/workspace-unread-raise-capability'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/worktree-a'
const SSH_WT = 'repo-ssh::/home/me/worktree-b'
const FOLDER_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER = folderWorkspaceKey(FOLDER_ID)
const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = `tab-1:${LEAF}`
const PHONE: RpcDispatchStreamingOptions = { clientKind: 'mobile', connectionId: 'phone-1' }

type Flag = { lastActivityAt: number; isUnread: boolean }

/** What each kind of desktop socket sends: the request and subscription sockets, the browser host
 *  lease and network tunnel (which add only browser capabilities to the shared base), and the CLI. */
function currentDesktopSockets() {
  return {
    request: remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES),
    lease: remoteRuntimeClientCapabilities([
      BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
      BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
    ]),
    tunnel: remoteRuntimeClientCapabilities([
      BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
      BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
    ]),
    cli: remoteRuntimeClientCapabilities()
  }
}

function createHeadlessHost() {
  const meta: Record<string, Flag> = { [WT]: { lastActivityAt: 0, isUnread: false } }
  const sshMeta: Record<string, Flag> = { [SSH_WT]: { lastActivityAt: 0, isUnread: false } }
  const folders: Record<string, Flag & { projectGroupId: string }> = {
    [FOLDER_ID]: { lastActivityAt: 0, isUnread: false, projectGroupId: 'group-1' }
  }
  const repos = [
    { id: 'repo-1', connectionId: null },
    { id: 'repo-ssh', connectionId: 'build-box' }
  ]
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjectGroups: () => [{ id: 'group-1', connectionId: null }],
    getSettings: () => ({}),
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: (id: string, updates: Partial<Flag>) => Object.assign(meta[id], updates),
    getWorktreeMetaForHost: (id: string, hostId: string) =>
      hostId === 'ssh:build-box' ? sshMeta[id] : undefined,
    setWorktreeMetaForHost: (id: string, _hostId: string, updates: Partial<Flag>) =>
      Object.assign(sshMeta[id], updates),
    getFolderWorkspace: (id: string) => folders[id],
    updateFolderWorkspace: (id: string, updates: Partial<Flag>) =>
      Object.assign(folders[id], updates)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the unread path reads only these members.
  const runtime = new OrcaRuntimeService(store as unknown as RuntimeStore)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [{ tabId: 'tab-1', worktreeId: WT, title: 'Agent', activeLeafId: LEAF, layout: null }],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WT,
        leafId: LEAF,
        paneRuntimeId: 1,
        ptyId: 'pty-1',
        paneTitle: null
      }
    ]
  })
  const server = new AgentHookServer()
  runtime.attachAgentStatusStore(server)
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...SIDEBAR_INPUT_METHODS, ...SESSION_TAB_METHODS]
  })
  let requestId = 0
  const finishTurn = (worktreeId = WT, connectionId?: string): void => {
    for (const state of ['working', 'done'] as const) {
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId,
        ...(connectionId ? { connectionId } : {}),
        payload: { state, prompt: 'task', agentType: 'claude' }
      })
    }
  }
  return {
    runtime,
    meta,
    sshMeta,
    folders,
    finishTurn,
    // The phone's session screen holds this stream while the workspace is open on it.
    openOnPhone: (worktreeId: string) =>
      dispatcher.dispatchStreaming(
        {
          id: `sub-${++requestId}`,
          authToken: 'tok',
          method: 'session.tabs.subscribe',
          params: { worktree: `id:${worktreeId}` }
        },
        () => {},
        PHONE
      ),
    reportView: (params: unknown, connectionId: string | undefined) =>
      dispatcher.dispatch(
        { id: `view-${++requestId}`, authToken: 'tok', method: 'sidebarInputs.reportView', params },
        { clientKind: 'runtime', connectionId }
      )
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('workspace unread flag on a headless host', () => {
  it('flags a finish no one sees, clears it when the phone opens it, and spares it while open', async () => {
    const host = createHeadlessHost()
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(true)

    await host.openOnPhone(WT)
    expect(host.meta[WT].isUnread).toBe(false)
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(false)

    // Leaving the session (its stream closes with the connection) makes the next finish news.
    host.runtime.cleanupSubscriptionsForConnection('phone-1')
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(true)
  })

  it('clears a folder workspace and an SSH worktree on their own records when the phone opens them', async () => {
    const host = createHeadlessHost()
    host.folders[FOLDER_ID].isUnread = true
    host.sshMeta[SSH_WT].isUnread = true
    await host.openOnPhone(FOLDER)
    expect(host.folders[FOLDER_ID].isUnread).toBe(false)
    await host.openOnPhone(SSH_WT)
    expect(host.sshMeta[SSH_WT].isUnread).toBe(false)

    // The SSH finish raises the SSH host's record once the phone has left.
    host.runtime.cleanupSubscriptionsForConnection('phone-1')
    host.finishTurn(SSH_WT, 'build-box')
    expect(host.sshMeta[SSH_WT].isUnread).toBe(true)
  })

  it('spares the tab a client window shows while its user is present', async () => {
    vi.useFakeTimers({ now: 10_000, toFake: ['Date'] })
    try {
      const host = createHeadlessHost()
      const view = { workspaceIds: [WT], tabIds: ['tab-1'], presentForMs: 60_000 }
      expect(await host.reportView(view, 'desktop-1')).toMatchObject({ ok: true })
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(false)

      // Another tab on screen is not this pane's.
      await host.reportView({ ...view, tabIds: ['tab-2'] }, 'desktop-1')
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(true)

      host.meta[WT].isUnread = false
      await host.reportView(view, 'desktop-1')
      vi.setSystemTime(10_000 + 60_000)
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(true)

      // A client that disconnects stops counting; one with no connection cannot report.
      expect(await host.reportView(view, undefined)).toMatchObject({ ok: false })
      host.meta[WT].isUnread = false
      await host.reportView({ ...view, presentForMs: null }, 'desktop-1')
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(false)
      host.runtime.cleanupSubscriptionsForConnection('desktop-1')
      host.finishTurn()
      expect(host.meta[WT].isUnread).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('advertises that it raises the flag, so no socket of a current desktop silences it', () => {
    const host = createHeadlessHost()
    expect(host.runtime.getStatus().capabilities).toContain(WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
    const facts = requireSwitchedOn(host.runtime.sidebarFacts)
    for (const [connectionId, capabilities] of Object.entries(currentDesktopSockets())) {
      facts.noteRuntimeClient(connectionId, capabilities)
    }
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(true)
  })

  it('leaves raising to an older desktop while it is connected, and still clears on the phone', async () => {
    const host = createHeadlessHost()
    // Either its request socket or its browser host lease hosts client pages without the capability.
    const older = (capabilities: readonly string[]) =>
      capabilities.filter((capability) => capability !== WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
    const facts = requireSwitchedOn(host.runtime.sidebarFacts)
    facts.noteRuntimeClient('desktop-old', older(currentDesktopSockets().request))
    facts.noteRuntimeClient('desktop-old-lease', older(currentDesktopSockets().lease))
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(false)

    // The older desktop raised it by its own rule; the phone opening it still clears it here.
    host.meta[WT].isUnread = true
    await host.openOnPhone(WT)
    expect(host.meta[WT].isUnread).toBe(false)
    host.runtime.cleanupSubscriptionsForConnection('phone-1')

    host.runtime.cleanupSubscriptionsForConnection('desktop-old')
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(false)
    host.runtime.cleanupSubscriptionsForConnection('desktop-old-lease')
    host.finishTurn()
    expect(host.meta[WT].isUnread).toBe(true)
  })
})
