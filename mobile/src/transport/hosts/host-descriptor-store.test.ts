import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  recordHostDescriptor,
  resetHostDescriptorStoreForTests,
  useHostDescriptor
} from './host-descriptor-store'

describe('host descriptor store', () => {
  let renderer: ReactTestRenderer | null = null
  const seen: Record<string, ReturnType<typeof useHostDescriptor>[]> = {}

  function Row({ hostId }: { hostId: string }): null {
    const descriptor = useHostDescriptor(hostId)
    ;(seen[hostId] ??= []).push(descriptor)
    return null
  }

  beforeEach(() => {
    resetHostDescriptorStoreForTests()
    for (const hostId of Object.keys(seen)) {
      delete seen[hostId]
    }
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('publishes the latest reply, including one that omitted both fields', async () => {
    await act(async () => {
      renderer = create(createElement(Row, { hostId: 'host-1' }))
    })
    await act(async () => {
      recordHostDescriptor('host-1', { machineName: 'Old', platform: 'win32' })
    })
    expect(seen['host-1']?.at(-1)).toEqual({ machineName: 'Old', platform: 'win32' })

    await act(async () => {
      recordHostDescriptor('host-1', { machineName: null, platform: null })
    })
    expect(seen['host-1']?.at(-1)).toEqual({ machineName: null, platform: null })
  })
})
