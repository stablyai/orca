import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node-pty', () => {
  throw new Error('node-pty native binding failed to load')
})

import { loadLocalPtyRuntimeSpawn } from './local-pty-runtime-spawn'
import { onNodePtyLoadFailure } from './node-pty-load-failure'

let unsubscribe = (): void => {}
afterEach(() => unsubscribe())

describe('loadLocalPtyRuntimeSpawn', () => {
  it('reports a node-pty load failure to listeners, then rethrows it', async () => {
    const failures = vi.fn()
    unsubscribe = onNodePtyLoadFailure(failures)

    await expect(loadLocalPtyRuntimeSpawn()).rejects.toThrow()

    expect(failures).toHaveBeenCalledOnce()
  })
})
