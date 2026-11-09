import { afterEach, expect, it, vi } from 'vitest'
import {
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

afterEach(resetLoginShellEnvironmentCacheForTests)

type Spawner = (shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>

it('answers a lookup only with a run that started no earlier, so a run predating an install never counts', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const predatesInstall = Promise.withResolvers<NodeJS.ProcessEnv | null>()
    const spawner = vi
      .fn<Spawner>()
      .mockResolvedValueOnce({ PATH: '/old' })
      .mockReturnValueOnce(predatesInstall.promise)
      .mockResolvedValueOnce({ PATH: '/installed' })
    const options = { shellOverride: '/bin/bash', env: { HOME: '/host' }, spawner }
    await resolveLoginShellEnvironment(options)
    // A background rerun that read the shell before the agent was installed is still going.
    vi.advanceTimersByTime(10_000)
    await resolveLoginShellEnvironment({ ...options, refreshAfterMs: 10_000 })
    expect(spawner).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    const askedAt = Date.now()
    const lookups = [
      resolveLoginShellEnvironment({ ...options, startedAfter: askedAt }),
      resolveLoginShellEnvironment({ ...options, startedAfter: askedAt })
    ]
    expect(spawner).toHaveBeenCalledTimes(3)
    await expect(Promise.all(lookups)).resolves.toEqual([
      { PATH: '/installed' },
      { PATH: '/installed' }
    ])
    predatesInstall.resolve({ PATH: '/old' })
    await new Promise((resolve) => setImmediate(resolve))
    await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/installed' })
  } finally {
    vi.useRealTimers()
  }
})
