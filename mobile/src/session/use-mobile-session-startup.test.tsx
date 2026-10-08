import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { useMobileSessionStartup } from './use-mobile-session-startup'

const WORKTREE_ID = 'server-repo::/srv/orca'

function fakeClient(reply: (method: string) => unknown): RpcClient & {
  sendRequest: ReturnType<typeof vi.fn>
} {
  const sendRequest = vi.fn(async (method: string) => ({
    id: method,
    ok: true,
    result: reply(method)
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only sends requests.
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

/** Opens a workspace's session route: on a server when `executionHost` is set. */
async function openSession(options: {
  client: RpcClient
  desktopClient: RpcClient
  executionHost?: 'runtime:env-1'
}) {
  const showToast = vi.fn()
  function Session() {
    useMobileSessionStartup(
      mountFixture<Parameters<typeof useMobileSessionStartup>[0]>({
        hostId: 'host-1',
        worktreeId: WORKTREE_ID,
        isFloatingWorkspaceRoute: false,
        connState: 'connected',
        client: options.client,
        desktopClient: options.desktopClient,
        executionHost: options.executionHost,
        setTerminals: () => {},
        terminalsRef: { current: [] },
        setSessionTabs: () => {},
        appliedSnapshotMarkerRef: { current: { epoch: null, version: -1 } },
        closedTabTombstonesRef: { current: new Map() },
        setTerminalsLoaded: () => {},
        setActiveHandle: () => {},
        setActiveSessionTabId: () => {},
        setMarkdownDocs: () => {},
        setFileDocs: () => {},
        terminalGestureInputQueuesRef: { current: new Map() },
        terminalGestureInputInFlightRef: { current: new Set() },
        sessionTabActionSheetKeyboardHideSubRef: { current: null },
        sessionTabActionSheetRequestSeqRef: { current: 0 },
        initializedHandlesRef: { current: new Set() },
        terminalDiagnosticsRef: { current: { resetRoute: () => {} } },
        activeHandleRef: { current: null },
        activeSessionTabTypeRef: { current: null },
        pendingSelectionRef: { current: null },
        selectedSessionTabIdRef: { current: null },
        pendingBrowserFocusPageIdRef: { current: null },
        pendingTerminalActivationAttemptRef: { current: null },
        initialSessionAutoCreateRef: { current: null },
        bufferedTerminalDraftState: { resetDrafts: () => {}, clearPendingRestorations: () => {} },
        clearPendingLiveInputCommit: () => {},
        clearDelayedActionTimers: () => {},
        showToast,
        clearTerminalCache: () => {},
        fetchTerminals: async () => true,
        ensureSessionTabs: async () => {}
      })
    )
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(createElement(Session))
  })
  await act(async () => {
    await Promise.resolve()
  })
  act(() => renderer?.unmount())
  return { showToast }
}

describe('opening a session wakes its slept agents where the desktop holds them', () => {
  it("asks the desktop to wake a server workspace's agents, and says once when nothing could", async () => {
    const server = fakeClient(() => ({
      activated: true,
      sleepingAgentWake: 'unsupported-headless'
    }))
    const desktop = fakeClient(() => ({ sleepingAgentWake: 'unsupported-headless' }))

    const { showToast } = await openSession({
      client: server,
      desktopClient: desktop,
      executionHost: 'runtime:env-1'
    })

    expect(server.sendRequest.mock.calls.map(([method]) => method)).toEqual(['worktree.activate'])
    expect(desktop.sendRequest.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['mobileRelay.hosts.wakeSleepingAgents', { hostId: 'runtime:env-1', worktreeId: WORKTREE_ID }]
    ])
    expect(showToast.mock.calls).toEqual([['Open Orca on the host to wake sleeping agents.', 3000]])
  })

  it("leaves the desktop's own workspace to its activation", async () => {
    const desktop = fakeClient(() => ({ activated: true, sleepingAgentWake: 'requested' }))

    const { showToast } = await openSession({ client: desktop, desktopClient: desktop })

    expect(desktop.sendRequest.mock.calls.map(([method]) => method)).toEqual(['worktree.activate'])
    expect(showToast).not.toHaveBeenCalled()
  })
})
