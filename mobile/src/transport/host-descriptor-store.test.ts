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

  it('has nothing to show before the host answers a status read', async () => {
    await act(async () => {
      renderer = create(createElement(Row, { hostId: 'host-1' }))
    })

    expect(seen['host-1']?.at(-1)).toBeNull()
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

  it('does not re-render for an unchanged reply', async () => {
    recordHostDescriptor('host-1', { machineName: 'Desk', platform: 'darwin' })
    await act(async () => {
      renderer = create(createElement(Row, { hostId: 'host-1' }))
    })
    const renders = seen['host-1']?.length ?? 0
    await act(async () => {
      recordHostDescriptor('host-1', { machineName: 'Desk', platform: 'darwin' })
    })

    expect(seen['host-1']).toHaveLength(renders)
  })

  it("does not re-render another host's row", async () => {
    await act(async () => {
      renderer = create(
        createElement(
          'rows',
          null,
          createElement(Row, { hostId: 'host-1' }),
          createElement(Row, { hostId: 'host-2' })
        )
      )
    })
    const host2Renders = seen['host-2']?.length ?? 0
    await act(async () => {
      recordHostDescriptor('host-1', { machineName: 'Desk', platform: 'darwin' })
    })

    expect(seen['host-2']).toHaveLength(host2Renders)
  })
})
