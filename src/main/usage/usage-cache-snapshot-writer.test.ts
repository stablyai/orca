import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { UsageCacheSnapshotWriter } from './usage-cache-snapshot-writer'

it.skipIf(process.platform === 'win32')(
  'replaces a world-readable usage cache with an owner-only snapshot',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-usage-cache-mode-'))
    try {
      const file = join(directory, 'orca-claude-usage.json')
      writeFileSync(file, '{}')
      chmodSync(file, 0o644)
      const writer = new UsageCacheSnapshotWriter('[test]', () => file)

      await writer.write(() => '{"sessionId":"s"}')

      expect(readFileSync(file, 'utf8')).toBe('{"sessionId":"s"}')
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
