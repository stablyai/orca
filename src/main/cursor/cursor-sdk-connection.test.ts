import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openCursorSdkConnection } from './cursor-sdk-connection'

describe('openCursorSdkConnection', () => {
  it('kills a sidecar that does not exit when stdin closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-sidecar-'))
    const entry = join(root, 'hang.js')
    await writeFile(entry, 'setInterval(() => {}, 1_000)\n')
    try {
      const connection = await openCursorSdkConnection({ apiKey: 'test-key', entryPath: entry })
      await expect(connection.close({ force: true })).resolves.toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
