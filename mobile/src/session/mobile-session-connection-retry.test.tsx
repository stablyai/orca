import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ForceReconnect } from '../transport/rpc-client-context-contract'

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

import { useMobileSessionPresentation } from './use-mobile-session-presentation'

type Presentation = ReturnType<typeof useMobileSessionPresentation>

/** A session whose host the shell's client has failed to reach twenty times. */
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
    terminalFrameHeightRef: { current: 0 },
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
    const { showConnectionRetry, terminalSummary } = present(null)
    expect({ showConnectionRetry, terminalSummary }).toEqual({
      showConnectionRetry: false,
      terminalSummary: "Can't reach desktop"
    })
  })

  it('is still offered natively', () => {
    const { showConnectionRetry, terminalSummary } = present(() => Promise.resolve())
    expect({ showConnectionRetry, terminalSummary }).toEqual({
      showConnectionRetry: true,
      terminalSummary: "Can't reach desktop — tap to retry"
    })
  })
})
