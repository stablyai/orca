import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { DiffNotesDelivery, MobileSessionTab } from './mobile-session-route-types'
import type { PendingSessionSelection } from './pending-session-selection'
import { releaseTerminalCreateLock } from './terminal-create-lock'
import { useMobileSessionDiffComments } from './use-mobile-session-diff-comments'
import { useMobileSessionPanelRouteActions } from './use-mobile-session-panel-route-actions'
import { useMobileSessionTerminalCreateActions } from './use-mobile-session-terminal-create-actions'

vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn(),
  triggerSelection: vi.fn()
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }))
vi.mock('lucide-react-native', () => ({ Bot: 'Bot' }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1'
]
const NOTE: DiffComment = {
  id: 'note-1',
  worktreeId: 'workspace-1',
  filePath: 'src/a.ts',
  lineNumber: 3,
  body: 'rename this',
  createdAt: 1,
  side: 'modified',
  source: 'diff'
}

function launchReply(promptOutcome: 'handed-to-terminal' | 'not-delivered'): RpcResponse {
  return {
    id: 'x',
    ok: true,
    result: {
      outcome: { kind: 'terminal', handle: 'term_7' },
      worktreeId: 'workspace-1',
      receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' },
      prompt: { delivery: 'submit', outcome: promptOutcome }
    },
    _meta: { runtimeId: 'r' }
  }
}

/** Launch replies answered by hand; the notes reader never answers, so the seeded notes stand. */
function launchClient() {
  const replies: ((reply: RpcResponse) => void)[] = []
  const sendRequest = vi.fn(
    (method: string) =>
      new Promise<RpcResponse>((resolve) => {
        if (method === 'agent.launchReplay') {
          replies.push(resolve)
        }
      })
  )
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const launches = () =>
    sendRequest.mock.calls.filter(([method]) => method === 'agent.launchReplay')
  return { client, replies, launches }
}

type Screen = {
  send: () => void
  sendActions: { onPress: () => void }[]
  pendingDelivery: DiffNotesDelivery | null
  sendingIds: ReadonlySet<string>
  creatingTerminalRef: { current: string | null }
}

let renderer: ReactTestRenderer | undefined
let rendered: Screen | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  rendered = undefined
})

function screen(): Screen {
  if (!rendered) {
    throw new Error('session screen not mounted')
  }
  return rendered
}

async function mountSessionScreen(client: RpcClient): Promise<void> {
  function Harness() {
    const [diffComments, setDiffComments] = useState<DiffComment[]>([NOTE])
    const diffCommentsRef = useRef(diffComments)
    diffCommentsRef.current = diffComments
    const [diffCommentBusy, setDiffCommentBusy] = useState(false)
    const [pendingDiffNotesDelivery, setPendingDiffNotesDelivery] =
      useState<DiffNotesDelivery | null>(null)
    const creatingTerminalRef = useRef<string | null>(null)
    const [, setCreating] = useState(false)
    const sessionTabsRef = useRef<MobileSessionTab[]>([])
    const pendingSelectionRef = useRef<PendingSessionSelection | null>(null)
    const base = {
      worktreeId: 'workspace-1',
      isFloatingWorkspaceRoute: false,
      client,
      hostCapabilities: LAUNCH_CAPABILITIES,
      connState: 'connected',
      diffComments,
      setDiffComments,
      diffCommentsRef,
      diffCommentBusy,
      setDiffCommentBusy,
      pendingDiffNotesDelivery,
      setPendingDiffNotesDelivery,
      showToast: () => {},
      setTerminals: () => {},
      terminalsRef: { current: [] },
      setSessionTabs: () => {},
      sessionTabsRef,
      defaultTerminalHandlesToLiveInput: () => {},
      setActiveHandle: () => {},
      activeSessionTabId: 'existing-tab',
      setActiveSessionTabId: () => {},
      setCreating,
      creatingTerminalRef,
      creatingBrowser: false,
      creatingMarkdown: false,
      setCreateError: () => {},
      deviceTokenRef: { current: null },
      initializedHandlesRef: { current: new Set<string>() },
      activeHandleRef: { current: 'existing-terminal' },
      activeSessionTabTypeRef: { current: 'terminal' },
      pendingSelectionRef,
      scheduleDelayedAction: () => {},
      unsubscribeTerminal: () => {},
      subscribeToTerminal: () => {},
      fetchSessionTabs: async () => {},
      createTabAgentLoadState: 'loaded',
      createTabAgentOptions: [{ agent: 'codex', label: 'Codex' }],
      setSessionContentRowWidth: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member these hooks read on the send path; a missing one throws on use.
    const notes = useMobileSessionDiffComments(base as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const createActions = useMobileSessionTerminalCreateActions({ ...base, ...notes } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    const route = useMobileSessionPanelRouteActions({
      ...base,
      ...notes,
      ...createActions
    } as never)
    rendered = {
      send: notes.sendDiffCommentsToAgent,
      sendActions: route.sendDiffNotesAgentActions,
      pendingDelivery: pendingDiffNotesDelivery,
      sendingIds: notes.sendingDiffCommentIds,
      creatingTerminalRef
    }
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
}

/** "Send review notes to AI", then the sheet's first new agent session. */
async function sendNotesToNewAgent(): Promise<void> {
  await act(async () => screen().send())
  await act(async () => screen().sendActions[0]?.onPress())
}

/** The launched tab landed, which frees the "+" lock long before a prompted reply. */
function landLaunchedTab(): void {
  const { creatingTerminalRef } = screen()
  const lock = creatingTerminalRef.current
  if (lock === null) {
    throw new Error('no launch holds the "+" lock')
  }
  releaseTerminalCreateLock({ creatingTerminalRef, setCreating: () => {} }, lock)
}

describe('sending review notes to a new agent session', () => {
  it('starts one agent while the first send of the same notes is still waiting on its reply', async () => {
    const { client, replies, launches } = launchClient()
    await mountSessionScreen(client)
    await act(async () => screen().send())
    const [sheetAction] = screen().sendActions
    await act(async () => sheetAction?.onPress())
    expect(launches()).toHaveLength(1)
    landLaunchedTab()

    // The notes are no longer offered, and a stale tap on the old sheet starts nothing.
    await act(async () => screen().send())
    expect(screen().pendingDelivery).toBeNull()
    await act(async () => sheetAction?.onPress())

    expect(launches()).toHaveLength(1)
    expect(screen().sendingIds).toEqual(new Set([NOTE.id]))

    // Delivered: the notes leave the list rather than becoming sendable again.
    await act(async () => replies[0]?.(launchReply('handed-to-terminal')))
    expect(screen().sendingIds.size).toBe(0)
    await act(async () => screen().send())
    expect(screen().pendingDelivery).toBeNull()
  })

  it('lets the notes be sent again once the host says they were not delivered', async () => {
    const { client, replies, launches } = launchClient()
    await mountSessionScreen(client)
    await sendNotesToNewAgent()
    landLaunchedTab()

    await act(async () => replies[0]?.(launchReply('not-delivered')))
    expect(screen().sendingIds.size).toBe(0)
    await sendNotesToNewAgent()

    expect(launches()).toHaveLength(2)
  })
})
