import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('failed-I/O teardown with a real bundled Bun PTY', () => {
  it.each([
    ['write', false],
    ['write', true],
    ['resize', false],
    ['resize', true]
  ] as const)(
    'reaps real shells and master fds after %s failure (immediate=%s)',
    async (operation, immediate) => {
      expect(
        await runBundledBunFixture(
          join(__dirname, 'pty-subprocess-io-failure-bun-fixture.ts'),
          'runNativeIoFailureFixture',
          { operation, immediate },
          15_000
        )
      ).toBe(4)
    },
    20_000
  )
})
