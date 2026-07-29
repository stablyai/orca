import { describe, expect, it } from 'vitest'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'

describe('main process lifecycle identity', () => {
  it('stays stable for the lifetime of the main process', () => {
    const first = getMainProcessLifecycleIdentity()
    const second = getMainProcessLifecycleIdentity()

    expect(second).toBe(first)
    expect(first).toEqual({
      mainProcessPid: process.pid,
      mainProcessLaunchId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
      mainProcessStartedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    })
  })
})
