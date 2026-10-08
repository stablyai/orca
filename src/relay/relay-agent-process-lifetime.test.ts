import { describe, expect, it } from 'vitest'
import { spawnProcess } from '../shared/child-process/run-process'
import { RelayAgentProcessLifetime } from './relay-agent-process-lifetime'

describe.skipIf(process.platform === 'win32')('RelayAgentProcessLifetime', () => {
  it('finishes on the child exit when a background process keeps its output pipes open', async () => {
    const lifetime = new RelayAgentProcessLifetime(5_000, 50)
    // The wrapper exits at once; `sleep` inherits stdout/stderr and holds them for 5s.
    const child = spawnProcess({ program: '/bin/sh', args: ['-c', 'sleep 5 & exit 0'] })
    let closed = false
    child.once('close', () => {
      closed = true
    })
    lifetime.track(child)
    await expect(lifetime.dispose()).resolves.toBeUndefined()
    expect(closed).toBe(true)
  })
})
