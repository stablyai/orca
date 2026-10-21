import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSerializedStoredState } from './use-serialized-stored-state'

type Hook = ReturnType<typeof useSerializedStoredState<string>>
let latest: Hook | null = null
let renderer: ReactTestRenderer | null = null

function mount(load: () => Promise<string>, save: (value: string) => Promise<void>): void {
  function Harness(): null {
    latest = useSerializedStoredState('a', load, save)
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  latest = null
})

describe('useSerializedStoredState', () => {
  it('shows the stored value again when a save is refused', async () => {
    mount(
      async () => 'a',
      async () => {
        throw new Error('refused')
      }
    )
    await act(async () => {
      latest?.setValue('b')
      latest?.persist('b')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(latest?.value).toBe('a')
  })

  it('leaves a later queued write in charge when an earlier save is refused', async () => {
    const load = vi.fn(async () => 'a')
    let landLater: () => void = () => {}
    const save = vi.fn((value: string) =>
      value === 'b'
        ? Promise.reject(new Error('refused'))
        : new Promise<void>((resolve) => {
            landLater = resolve
          })
    )
    mount(load, save)
    await act(async () => {
      latest?.persist('b')
      latest?.setValue('c')
      latest?.persist('c')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(load).not.toHaveBeenCalled()
    await act(async () => {
      landLater()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(load).not.toHaveBeenCalled()
    expect(latest?.value).toBe('c')
  })
})
