import { afterEach, expect, it, vi } from 'vitest'
import {
  captureLoginShellEnvironment,
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

afterEach(resetLoginShellEnvironmentCacheForTests)

it('shares concurrent probes only within the same shell and environment', async () => {
  const release = Promise.withResolvers<void>()
  const spawner = vi.fn(async (_shell: string, env: NodeJS.ProcessEnv) => {
    await release.promise
    return { PI_CONFIG_DIR: env.PROFILE_ROOT }
  })
  const first = { HOME: '/host/a', PROFILE_ROOT: '.first' }
  const second = { HOME: '/host/a', PROFILE_ROOT: '.second' }
  const pending = [
    resolveLoginShellEnvironment({ shellOverride: '/bin/bash', env: first, spawner }),
    resolveLoginShellEnvironment({ shellOverride: '/bin/bash', env: second, spawner }),
    ...Array.from({ length: 20 }, () =>
      resolveLoginShellEnvironment({
        shellOverride: '/bin/bash',
        env: { PROFILE_ROOT: '.first', HOME: '/host/a' },
        spawner
      })
    )
  ]
  expect(spawner).toHaveBeenCalledTimes(2)
  release.resolve()
  const values = await Promise.all(pending)
  expect(values[0]?.PI_CONFIG_DIR).toBe('.first')
  expect(values[1]?.PI_CONFIG_DIR).toBe('.second')
  expect(values.slice(2).every((value) => value.PI_CONFIG_DIR === '.first')).toBe(true)
  await resolveLoginShellEnvironment({ shellOverride: '/bin/zsh', env: first, spawner })
  expect(spawner).toHaveBeenCalledTimes(3)
})

it('falls back to the supplied execution environment when its shell probe fails', async () => {
  const env = { HOME: '/execution-host', PI_CONFIG_DIR: '.execution-root' }
  const spawner = vi.fn(async () => {
    throw new Error('probe failed')
  })
  await expect(
    resolveLoginShellEnvironment({ shellOverride: '/bin/bash', env, spawner })
  ).resolves.toEqual(env)
})

it('bounds retained environments and supports explicit refresh', async () => {
  const spawner = vi.fn(async (_shell: string, env: NodeJS.ProcessEnv) => env)
  for (let index = 0; index < 10; index++) {
    await resolveLoginShellEnvironment({
      shellOverride: '/bin/bash',
      env: { HOME: `/host/${index}` },
      spawner
    })
  }
  await resolveLoginShellEnvironment({
    shellOverride: '/bin/bash',
    env: { HOME: '/host/0' },
    spawner
  })
  expect(spawner).toHaveBeenCalledTimes(11)
  await resolveLoginShellEnvironment({
    shellOverride: '/bin/bash',
    env: { HOME: '/host/0' },
    spawner,
    startedAfter: Date.now()
  })
  expect(spawner).toHaveBeenCalledTimes(12)
})

it('says whether the shell produced the env, and a failed rerun keeps the cached one', async () => {
  const env = { HOME: '/host' }
  const spawner = vi
    .fn<(shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>>()
    .mockResolvedValueOnce({ PATH: '/profile/bin' })
    .mockResolvedValueOnce(null)
  const options = { shellOverride: '/bin/bash', env, spawner }
  await expect(captureLoginShellEnvironment(options)).resolves.toEqual({
    status: 'captured',
    env: { PATH: '/profile/bin' }
  })
  await expect(
    captureLoginShellEnvironment({ ...options, startedAfter: Date.now() })
  ).resolves.toEqual({
    status: 'fallback',
    env
  })
  await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/profile/bin' })
  expect(spawner).toHaveBeenCalledTimes(2)
})

it('serves the cached env to other readers while a rerun runs', async () => {
  const release = Promise.withResolvers<NodeJS.ProcessEnv | null>()
  const spawner = vi
    .fn<(shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>>()
    .mockResolvedValueOnce({ PATH: '/first' })
    .mockReturnValueOnce(release.promise)
  const options = { shellOverride: '/bin/bash', env: { HOME: '/host' }, spawner }
  await resolveLoginShellEnvironment(options)
  const forced = resolveLoginShellEnvironment({ ...options, startedAfter: Date.now() })
  const tick = new Promise((resolve) => setImmediate(() => resolve('still waiting')))
  await expect(Promise.race([resolveLoginShellEnvironment(options), tick])).resolves.toEqual({
    PATH: '/first'
  })
  release.resolve({ PATH: '/second' })
  await expect(forced).resolves.toEqual({ PATH: '/second' })
  await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/second' })
  expect(spawner).toHaveBeenCalledTimes(2)
})

it('serves a cached fallback to other readers while a rerun runs', async () => {
  const release = Promise.withResolvers<NodeJS.ProcessEnv | null>()
  const spawner = vi
    .fn<(shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>>()
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(release.promise)
  const env = { HOME: '/host' }
  const options = { shellOverride: '/bin/bash', env, spawner }
  await expect(captureLoginShellEnvironment(options)).resolves.toMatchObject({ status: 'fallback' })
  const forced = resolveLoginShellEnvironment({ ...options, startedAfter: Date.now() })
  const tick = new Promise((resolve) => setImmediate(() => resolve('still waiting')))
  await expect(Promise.race([resolveLoginShellEnvironment(options), tick])).resolves.toEqual(env)
  release.resolve({ PATH: '/profile/bin' })
  await expect(forced).resolves.toEqual({ PATH: '/profile/bin' })
  await expect(resolveLoginShellEnvironment(options)).resolves.toEqual({ PATH: '/profile/bin' })
  expect(spawner).toHaveBeenCalledTimes(2)
})

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

it('reruns a failed shell once its last attempt is older, and keeps a captured one when asked', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const spawner = vi
      .fn<Spawner>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ PATH: '/repaired' })
    const options = {
      shellOverride: '/bin/bash',
      env: { HOME: '/host' },
      spawner,
      refreshAfterMs: 10_000,
      keepCaptured: true
    }
    await expect(captureLoginShellEnvironment(options)).resolves.toMatchObject({
      status: 'fallback'
    })
    vi.advanceTimersByTime(9_999)
    await captureLoginShellEnvironment(options)
    expect(spawner).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    await captureLoginShellEnvironment(options)
    await vi.waitFor(async () => {
      expect((await captureLoginShellEnvironment(options)).env).toEqual({ PATH: '/repaired' })
    })
    vi.advanceTimersByTime(60_000)
    await captureLoginShellEnvironment(options)
    expect(spawner).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
