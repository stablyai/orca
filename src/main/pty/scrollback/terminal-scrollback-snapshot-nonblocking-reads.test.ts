import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const counts = vi.hoisted(() => ({ open: 0, peak: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      counts.open++
      counts.peak = Math.max(counts.peak, counts.open)
      return {
        stat: () => handle.stat(),
        read: handle.read.bind(handle),
        close: async () => {
          try {
            await handle.close()
          } finally {
            counts.open--
          }
        }
      }
    }
  }
})
import { readTerminalScrollbackSnapshot } from './terminal-scrollback-snapshot-nonblocking-reads'

// 3,300 serialized real filesystem reads need a wider timeout on slow CI disks.
it('bounds simultaneous snapshot handles and delivers every queued frame after a missing read at N and 10N', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-scrollback-reader-'))
  const snapshotRoot = join(scratch, 'terminal-scrollback')
  await mkdir(snapshotRoot)
  const ref = `v1-${'d'.repeat(32)}`
  await writeFile(join(snapshotRoot, `${ref}.bin`), 'saved frame 👩‍💻\n')
  try {
    for (const count of [300, 3_000]) {
      counts.peak = 0
      const outputs = await Promise.all([
        readTerminalScrollbackSnapshot(`v1-${'e'.repeat(32)}`, { snapshotRoot }),
        ...Array.from({ length: count }, () =>
          readTerminalScrollbackSnapshot(ref, { snapshotRoot })
        )
      ])
      expect(outputs[0]).toBeNull()
      expect(outputs.slice(1).every((text) => text === 'saved frame 👩‍💻\n')).toBe(true)
      expect(counts.peak).toBe(1)
      expect(counts.open).toBe(0)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 10_000)
