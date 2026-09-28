import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

const resultSchema = z.object({
  retiredSize: z.array(z.number()),
  retiredProcess: z.string(),
  output: z.string(),
  exitCode: z.number(),
  reusedDescriptor: z.boolean().nullable()
})

describe.skipIf(process.platform === 'win32')('Bun retired PTY handle isolation', () => {
  it.each([false, true])(
    'does not resize, write into or inspect a later PTY after exit (explicit destroy: %s)',
    async (destroy) => {
      const result = resultSchema.parse(
        await runBundledBunFixture(
          join(__dirname, 'bun-pty-retired-handle-fixture.ts'),
          'exerciseRetiredHandle',
          { destroy },
          10_000
        )
      )
      expect(result.retiredSize).toEqual([80, 24])
      expect(result.retiredProcess).toBe('/bin/sh')
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('24 80')
      expect(result.output).toContain('__READ:hello__')
      expect(result.output).not.toContain('leak')
      if (process.platform === 'linux') {
        // Prove the kernel actually reused the descriptor instead of testing unrelated handles.
        expect(result.reusedDescriptor).toBe(true)
      }
    },
    15_000
  )
})
