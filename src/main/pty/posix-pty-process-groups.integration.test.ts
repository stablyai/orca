import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

const itOnPosix = process.platform === 'win32' ? it.skip : it

itOnPosix(
  'reaps a foreground job that ignores terminal shutdown signals',
  async () => {
    const result = await runBundledBunFixture(
      join(__dirname, 'posix-pty-process-groups-fixture.ts'),
      'reapPosixForegroundJob',
      null,
      15_000
    )
    expect(result).toEqual({
      separateForegroundGroup: true,
      leaderExited: true,
      remainingTaggedProcesses: 0
    })
  },
  20_000
)
