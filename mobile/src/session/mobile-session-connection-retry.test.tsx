import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ForceReconnect } from '../transport/rpc-client-context-contract'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('../layout/use-shell-side-rail', () => ({
  useShellSideRail: () => false,
  useDirectionPadAvailable: () => false
}))

import { useMobileSessionPresentation } from './use-mobile-session-presentation'

type Presentation = ReturnType<typeof useMobileSessionPresentation>

function present(forceReconnectHost: ForceReconnect): Presentation {
  const scope = {
    created: undefined,
    worktreeId: 'wt-1',
    router: { setParams: () => {} },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    connState: 'reconnecting',
    client: null,
    reconnectAttempts: 20,
    lastConnectedAt: null,
    terminalsLoaded: false,
    activeHandle: null,
    creating: false,
    creatingBrowser: false,
    creatingMarkdown: false,
    keyboardHeight: 0,
    terminalKeyboardMetrics: new Map(),
    toastOpacityRef: { current: 1 },
    hostEndpoint: null,
    initialSessionAutoCreateRef: { current: null },
    terminalFrameRef: { current: null },
    handleCreateTerminal: () => Promise.resolve(),
    visibleTabs: [],
    forceReconnectHost
  }
  type Scope = Parameters<typeof useMobileSessionPresentation>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the presentation hook reads only these members of the session scope; the rest of the controller is unreachable from it.
  const sessionScope = scope as unknown as Scope
  const read: { value: Presentation | null } = { value: null }
  function Probe(): null {
    read.value = useMobileSessionPresentation(sessionScope)
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  if (read.value === null) {
    throw new Error('the hook did not run')
  }
  return read.value
}

describe("the session header's tap to retry", () => {
  it('is not offered on the page, and the status says what is wrong without promising a tap', () => {
    const { showConnectionRetry, connectionEscalated, terminalSummary } = present(null)
    expect({ showConnectionRetry, connectionEscalated, terminalSummary }).toEqual({
      showConnectionRetry: false,
      connectionEscalated: true,
      terminalSummary: "Can't reach desktop"
    })
  })

  it('is still offered natively', () => {
    const { showConnectionRetry, connectionEscalated, terminalSummary } = present(() =>
      Promise.resolve()
    )
    expect({ showConnectionRetry, connectionEscalated, terminalSummary }).toEqual({
      showConnectionRetry: true,
      connectionEscalated: true,
      terminalSummary: "Can't reach desktop — tap to retry"
    })
  })
})
