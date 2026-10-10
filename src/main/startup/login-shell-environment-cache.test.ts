import { afterEach, expect, it, vi } from 'vitest'
import {
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
    force: true
  })
  expect(spawner).toHaveBeenCalledTimes(12)
})
