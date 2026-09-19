import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: { endCoordinates: { height: number } }) => void

type KeyboardHarness = {
  listeners: Map<string, Listener>
  removed: string[]
  platform: 'ios' | 'android'
  /** Every call, not the surviving subscriptions: a hook that subscribes and unsubscribes still
   *  costs a phone a render per keyboard event, which `listeners.size` alone would not show. */
  addListenerCalls: number
}

const keyboard = vi.hoisted((): KeyboardHarness => ({
  listeners: new Map(),
  removed: [],
  platform: 'ios',
  addListenerCalls: 0
}))

vi.mock('react-native', () => ({
  Keyboard: {
    addListener: (name: string, listener: Listener) => {
      keyboard.addListenerCalls += 1
      keyboard.listeners.set(name, listener)
      return {
        remove: () => {
          keyboard.removed.push(name)
          keyboard.listeners.delete(name)
        }
      }
    }
  },
  Platform: {
    get OS() {
      return keyboard.platform
    }
  }
}))

import { useKeyboardAvoidingPadding, useKeyboardOcclusion } from './keyboard-occlusion'

let lift = 0
let padding = 0

function Harness(): null {
  lift = useKeyboardOcclusion()
  return null
}

/** Separate, so the padding case measures the padding hook's own subscriptions and nothing else. */
function PaddingHarness(): null {
  padding = useKeyboardAvoidingPadding()
  return null
}

async function mountComponent(component: () => null): Promise<ReturnType<typeof create>> {
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(createElement(component))
  })
  if (tree === null) {
    throw new Error('the harness did not mount')
  }
  return tree
}

const mount = async (): Promise<ReturnType<typeof create>> => mountComponent(Harness)

describe('the keyboard the phone reports', () => {
  beforeEach(() => {
    keyboard.listeners.clear()
    keyboard.removed.length = 0
    keyboard.platform = 'ios'
    keyboard.addListenerCalls = 0
    lift = 0
    padding = 0
  })

  it('animates with the keyboard on iOS and after it on Android', async () => {
    await mount()
    expect([...keyboard.listeners.keys()].sort()).toEqual(['keyboardWillHide', 'keyboardWillShow'])

    keyboard.platform = 'android'
    keyboard.listeners.clear()
    await mount()
    expect([...keyboard.listeners.keys()].sort()).toEqual(['keyboardDidHide', 'keyboardDidShow'])
  })

  it('lifts by the height the event carries and drops back on hide', async () => {
    await mount()
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: 336 } })
    })
    expect(lift).toBe(336)
    await act(async () => {
      keyboard.listeners.get('keyboardWillHide')?.({ endCoordinates: { height: 0 } })
    })
    expect(lift).toBe(0)
  })

  it('never reports a negative height, whatever the event says', async () => {
    await mount()
    await act(async () => {
      keyboard.listeners.get('keyboardWillShow')?.({ endCoordinates: { height: -10 } })
    })
    expect(lift).toBe(0)
  })

  it('removes both listeners on unmount', async () => {
    const tree = await mount()
    await act(async () => tree.unmount())
    expect(keyboard.removed.sort()).toEqual(['keyboardWillHide', 'keyboardWillShow'])
  })

  it('asks a phone for no composer padding, because KeyboardAvoidingView already moved it', async () => {
    // Rendered, not called: a hook read outside a component measures whatever the module does at
    // the top of its body and nothing its effects do, which is where a subscription would live.
    // And it subscribes to nothing doing it, so a composer that calls this renders as often as it
    // does today — which is what makes adding the call to a shared component safe.
    await mountComponent(PaddingHarness)
    expect(padding).toBe(0)
    expect(keyboard.addListenerCalls).toBe(0)
    expect(keyboard.listeners.size).toBe(0)
  })
})
