// Perf contract (STA-18400): concurrent cold misses each read and indexed the whole file (the shared MCP
// server lookup builds a name index per read), so a burst of C requests after a change did C reads.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIntegrationStateFileCache } from './integration-state-file-cache'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('integration state file cache reads', () => {
  it.each([10, 100])(
    'reads once for %i concurrent misses and again after an edit',
    async (count) => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-state-cache-'))
      dirs.push(dir)
      const file = join(dir, 'state.json')
      writeFileSync(file, 'a')
      let reads = 0
      let statsSettled: Promise<unknown> = Promise.resolve()
      const cache = createIntegrationStateFileCache({
        filePath: () => file,
        readFromDisk: async () => {
          reads++
          const read = reads
          // Hold the read open until every caller has stamped the file, as a slow parse would.
          await statsSettled
          return { read }
        }
      })
      // Stats queued after the callers' settle after theirs, so every caller misses before the first read ends.
      const burst = async (): Promise<{ read: number }[]> => {
        const gets = Array.from({ length: count }, () => cache.get())
        statsSettled = Promise.all(Array.from({ length: count }, () => stat(file)))
        return Promise.all(gets)
      }
      const cold = await burst()
      expect(reads).toBe(1)
      expect(new Set(cold).size).toBe(1)

      writeFileSync(file, 'edited')
      const edited = await burst()
      expect(reads).toBe(2)
      expect(edited.every((value) => value.read === 2)).toBe(true)
    }
  )
})
