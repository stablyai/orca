import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BottomDrawer } from './BottomDrawer'
import { MountedBottomDrawer } from './mounted-bottom-drawer'
import { useBottomDrawerFollowUp } from './use-bottom-drawer-follow-up'

vi.mock('./mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'MountedBottomDrawer' }))

describe('drawer handoff', () => {
  let renderer: ReactTestRenderer | undefined
  let handoff: ReturnType<typeof useBottomDrawerFollowUp> | undefined
  function Harness() {
    const [visible, setVisible] = useState(true)
    handoff = useBottomDrawerFollowUp(() => setVisible(false))
    return (
      <BottomDrawer visible={visible} {...handoff.drawerProps}>
        Source
      </BottomDrawer>
    )
  }
  function mount() {
    act(() => {
      renderer = create(createElement(Harness))
    })
  }
  afterEach(() => act(() => renderer?.unmount()))

  it('opens the next surface once, after the source drawer has unmounted', () => {
    mount()
    const next = vi.fn(() => expect(renderer?.toJSON()).toBeNull())
    act(() => handoff?.closeThen(next))
    expect(next).not.toHaveBeenCalled()
    expect(renderer?.toJSON()).not.toBeNull()
    const onHidden = renderer?.root.findByType(MountedBottomDrawer).props.onHidden
    act(() => onHidden())
    act(() => onHidden())
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not queue work for a backdrop or swipe dismissal', () => {
    mount()
    const afterClose = handoff?.drawerProps.onAfterClose
    act(() => handoff?.drawerProps.onClose())
    act(() => renderer?.root.findByType(MountedBottomDrawer).props.onHidden())
    act(() => afterClose?.())
    expect(renderer?.toJSON()).toBeNull()
  })

  it('drops queued work when its screen unmounts', () => {
    mount()
    const next = vi.fn()
    const afterClose = handoff?.drawerProps.onAfterClose
    act(() => handoff?.closeThen(next))
    act(() => renderer?.unmount())
    act(() => afterClose?.())
    expect(next).not.toHaveBeenCalled()
  })
})
