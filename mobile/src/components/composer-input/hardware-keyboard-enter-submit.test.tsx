import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SoftKeyboardState } from '../../platform/keyboard-occlusion'

const env = vi.hoisted((): { os: string; keyboard: SoftKeyboardState; metrics: number } => ({
  os: 'ios',
  keyboard: { height: 0, visible: false },
  metrics: 0
}))
vi.mock('../../platform/host-os', () => ({ hostOs: () => env.os }))
vi.mock('../../platform/keyboard-occlusion', () => ({
  useSoftKeyboard: () => env.keyboard,
  currentSoftKeyboardHeight: () => env.metrics
}))

import { useHardwareKeyboardEnterSubmit } from './hardware-keyboard-enter-submit'

async function propsFor(onSubmit: (() => void) | undefined) {
  let props: ReturnType<typeof useHardwareKeyboardEnterSubmit> = {}
  function Harness(): null {
    props = useHardwareKeyboardEnterSubmit(onSubmit)
    return null
  }
  await act(async () => {
    create(createElement(Harness))
  })
  return props
}

describe('hardware keyboard Return in the composer', () => {
  beforeEach(() => {
    env.os = 'ios'
    env.keyboard = { height: 0, visible: false }
    env.metrics = 0
  })

  it('sends on Return when no soft keyboard is up', async () => {
    const onSubmit = vi.fn()
    expect(await propsFor(onSubmit)).toEqual({
      submitBehavior: 'submit',
      onSubmitEditing: onSubmit
    })
  })

  it("treats iOS's hardware-keyboard shortcut bar as no soft keyboard", async () => {
    env.keyboard = { height: 70, visible: true }
    expect((await propsFor(vi.fn())).submitBehavior).toBe('submit')
  })

  it('keeps the on-screen Return as a newline', async () => {
    env.keyboard = { height: 336, visible: true }
    expect(await propsFor(vi.fn())).toEqual({ submitBehavior: 'newline' })
  })

  it('keeps the newline when mounted under an already open soft keyboard', async () => {
    env.metrics = 336
    expect(await propsFor(vi.fn())).toEqual({ submitBehavior: 'newline' })
  })

  it('leaves the field alone when there is nothing to send or off iOS', async () => {
    expect(await propsFor(undefined)).toEqual({})
    env.os = 'android'
    expect(await propsFor(vi.fn())).toEqual({})
  })
})
