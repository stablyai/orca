import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useMobileStructuredComposerState } from './use-mobile-structured-composer-state'

describe('useMobileStructuredComposerState', () => {
  let renderer: ReactTestRenderer | null = null
  let sessionId = 'mobile_1'
  let state: ReturnType<typeof useMobileStructuredComposerState> | null = null

  function Probe(): null {
    state = useMobileStructuredComposerState()
    return null
  }

  function Harness(): ReactNode {
    return createElement(Probe, { key: sessionId })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sessionId = 'mobile_1'
    act(() => {
      renderer = create(createElement(Harness))
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  it('clears draft text and restored attachments when the session changes', () => {
    act(() => {
      state!.setComposerText('do not leak')
      state!.setRestored([{ id: 'restored:1', path: '/host/a.png', previewUri: 'file:///a.png' }])
    })

    sessionId = 'mobile_2'
    act(() => renderer!.update(createElement(Harness)))

    expect(state!.composerText).toBe('')
    expect(state!.restored).toEqual([])
  })
})
