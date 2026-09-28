import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

describe.skipIf(process.platform !== 'win32')('Bun Windows native terminal I/O isolation', () => {
  it.each(['write-close', 'late-write', 'drain-close'] as const)(
    'contains %s while an unrelated native terminal remains writable',
    async (operation) => {
      const result = await runBundledBunFixture(
        join(__dirname, 'bun-pty-windows-io-failure-fixture.ts'),
        'runWindowsNativeIoFailure',
        { operation },
        60_000
      )
      expect(result).toMatchObject({
        victimExitCount: 1,
        witnessExitCount: 0,
        witnessWritable: true,
        uncaught: []
      })
      if (operation === 'write-close') {
        expect(result).toMatchObject({ nativeFailure: 'Terminal is closed' })
      }
      if (operation === 'drain-close') {
        expect(result).toMatchObject({ exitCode: 17, finalOutputBeforeExit: true })
      }
    },
    65_000
  )
})
