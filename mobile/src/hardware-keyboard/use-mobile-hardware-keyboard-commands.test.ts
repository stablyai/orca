import { createElement, startTransition, Suspense } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { HardwareKeyboardCommandEvent } from '@orca/expo-hardware-keyboard-navigation'
import { useMobileHardwareKeyboardCommands } from './use-mobile-hardware-keyboard-commands'

const registry = vi.hoisted(() => ({
  handler: null as null | ((event: HardwareKeyboardCommandEvent) => void)
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: useEffect }
})
vi.mock('./mobile-hardware-keyboard-registry', () => ({
  registerMobileHardwareKeyboardScope: (scope: typeof registry) => {
    registry.handler = scope.handler
    return () => {
      registry.handler = null
    }
  }
}))

it('publishes handlers only after a render commits', async () => {
  const first = vi.fn()
  const discarded = vi.fn()
  const committed = vi.fn()
  const pending = new Promise<void>(() => {})
  const actions = ['worktree.palette'] as const
  let attempted = false
  function Harness(props: { handler: typeof first; suspend?: boolean }) {
    useMobileHardwareKeyboardCommands({
      actionIds: actions,
      context: 'app',
      onCommand: props.handler
    })
    if (props.suspend) {
      attempted = true
      throw pending
    }
    return null
  }
  const tree = (handler: typeof first, suspend = false) =>
    createElement(Suspense, { fallback: null }, createElement(Harness, { handler, suspend }))
  let renderer: ReturnType<typeof create>
  await act(async () => {
    renderer = create(tree(first))
  })
  try {
    await act(async () => {
      startTransition(() => renderer.update(tree(discarded, true)))
    })
    expect(attempted).toBe(true)
    const event = { actionId: 'worktree.palette' } as HardwareKeyboardCommandEvent
    act(() => registry.handler?.(event))
    expect(first).toHaveBeenCalledOnce()
    expect(discarded).not.toHaveBeenCalled()
    await act(async () => {
      renderer.update(tree(committed))
    })
    act(() => registry.handler?.(event))
    expect(committed).toHaveBeenCalledOnce()
  } finally {
    act(() => renderer.unmount())
  }
  expect(registry.handler).toBeNull()
})
