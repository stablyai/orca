import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: { endCoordinates: { height: number } }) => void

type KeyboardHarness = {
  listeners: Map<string, Listener>
  removed: string[]
  platform: 'ios' | 'android'
}

const keyboard = vi.hoisted((): KeyboardHarness => ({
  listeners: new Map(),
  removed: [],
  platform: 'ios'
}))

vi.mock('react-native', () => ({
  Keyboard: {
    addListener: (name: string, listener: Listener) => {
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

function Harness(): null {
  lift = useKeyboardOcclusion()
  return null
}

async function mount(): Promise<ReturnType<typeof create>> {
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(createElement(Harness))
  })
  if (tree === null) {
    throw new Error('the harness did not mount')
  }
  return tree
}

describe('the keyboard the phone reports', () => {
  beforeEach(() => {
    keyboard.listeners.clear()
    keyboard.removed.length = 0
    keyboard.platform = 'ios'
    lift = 0
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

  it('asks a phone for no composer padding, because KeyboardAvoidingView already moved it', () => {
    // And subscribes to nothing doing it: a composer that calls this renders as often as it does
    // today, which is what makes adding the call to a shared component safe.
    expect(useKeyboardAvoidingPadding()).toBe(0)
    expect(keyboard.listeners.size).toBe(0)
  })
})
