import { expect, it } from 'vitest'
import {
  runWindowsWatcherBuild,
  runWindowsWatcherBuildCommand
} from './build-windows-watcher-addon.mjs'

it.each([false, true])('preserves a build timeout when cleanup fails: %s', (cleanupFails) => {
  const cleanupError = Object.assign(new Error('compiler still holds staging'), { code: 'EPERM' })
  let cleaned = false
  let failure
  try {
    runWindowsWatcherBuild(
      () =>
        runWindowsWatcherBuildCommand(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          process.cwd(),
          50
        ),
      () => {
        cleaned = true
        if (cleanupFails) {
          throw cleanupError
        }
      }
    )
  } catch (error) {
    failure = error
  }
  expect(cleaned).toBe(true)
  if (cleanupFails) {
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('timed out after 50ms') }),
      cleanupError
    ])
  } else {
    expect(failure.message).toContain('timed out after 50ms')
  }
})

it('cleans up a successful build before returning its artifact directory', () => {
  const events = []
  expect(
    runWindowsWatcherBuild(
      () => {
        events.push('build')
        return 'artifact'
      },
      () => {
        events.push('cleanup')
      }
    )
  ).toBe('artifact')
  expect(events).toEqual(['build', 'cleanup'])
})
