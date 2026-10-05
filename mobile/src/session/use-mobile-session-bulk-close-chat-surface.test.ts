import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileLeafView } from './mobile-session-chat-view'
import { useMobileSessionBulkClose } from './use-mobile-session-bulk-close'

vi.mock('./mobile-bulk-close-sheet-actions', () => ({
  createBulkCloseSheetActions: () => () => [],
  createCloseWithBulkActions: () => () => []
}))
vi.mock('./mobile-session-tab-activation', () => ({ activateMobileSessionTab: vi.fn() }))

const pendingRow = {
  type: 'terminal',
  id: 'P::L',
  title: '',
  leafId: 'L',
  status: 'pending-handle',
  terminal: null,
  isActive: true
}

describe('useMobileSessionBulkClose chat surface for a handle-less row (A1c-6)', () => {
  let renderer: ReactTestRenderer | null = null
  let model: ReturnType<typeof useMobileSessionBulkClose> | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    model = null
  })

  function render(markerSession: boolean, activeLeafView: MobileLeafView): void {
    function Harness(): null {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member this hook reads with no client; the rest of the session model is unreachable.
      model = useMobileSessionBulkClose({
        worktreeId: 'w',
        client: null,
        connState: 'connected',
        sessionTabs: [pendingRow],
        sessionTabsRef: { current: [pendingRow] },
        activeSessionTabIdRef: { current: 'P::L' },
        markdownDocs: new Map(),
        pendingTerminalActivationAttemptRef: { current: null },
        activeSessionTab: pendingRow,
        pendingTerminalRecoveryContextKey: null,
        parkedPendingTerminalContext: null,
        chatView: { markerSession, tabLeafView: () => activeLeafView }
      } as never)
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
  }

  it('renders a chosen chat over terminal recovery on a marker session', () => {
    render(true, 'chat')
    expect(model?.activePendingTerminalTab?.id).toBe('P::L')
    expect(model?.activeChatSurface).toBe(true)
  })

  it('keeps the recovery view when the host pair is terminal', () => {
    render(true, 'terminal')
    expect(model?.activeChatSurface).toBe(false)
  })

  it('keeps today’s pending view on a host without the marker (guard)', () => {
    render(false, 'chat')
    expect(model?.activeChatSurface).toBe(false)
    expect(model?.activeViewUndecided).toBe(false)
  })
})
