import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { KeybindingContext } from '../../../src/shared/keybindings'
import {
  useMobileSessionHardwareKeyboardContext,
  usePublishMobileSessionHardwareKeyboardContext
} from './mobile-session-hardware-keyboard-context'

describe('mobile session hardware keyboard context', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('publishes only to the matching route and restores app context on cleanup', () => {
    let matchingContext: KeybindingContext | null = null
    let otherContext: KeybindingContext | null = null

    function Publisher(): null {
      usePublishMobileSessionHardwareKeyboardContext({
        context: 'terminal',
        hostId: 'host-a',
        worktreeId: 'worktree-a'
      })
      return null
    }
    function Reader(): null {
      matchingContext = useMobileSessionHardwareKeyboardContext('host-a', 'worktree-a')
      otherContext = useMobileSessionHardwareKeyboardContext('host-b', 'worktree-a')
      return null
    }
    const renderHarness = (publish: boolean) =>
      createElement(
        Fragment,
        null,
        publish ? createElement(Publisher) : null,
        createElement(Reader)
      )

    act(() => {
      renderer = create(renderHarness(true))
    })
    expect(matchingContext).toBe('terminal')
    expect(otherContext).toBe('app')

    act(() => renderer?.update(renderHarness(false)))
    expect(matchingContext).toBe('app')
  })
})
