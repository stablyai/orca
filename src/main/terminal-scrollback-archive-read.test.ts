import { mkdtempSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  readTerminalScrollbackSnapshotSync,
  writeTerminalScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number) {
      return fs.readSync(fd, buffer, offset, Math.min(length, 7), position)
    }
  }
})

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('archives every stored byte when the filesystem returns short reads', () => {
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'orca-short-scrollback-read-'))
  directories.push(snapshotRoot)
  const buffer = 'complete scrollback\r\n🚢\u0000'.repeat(20)
  const ref = writeTerminalScrollbackSnapshotSync({
    tabId: 'tab',
    leafId: '33333333-3333-4333-8333-333333333333',
    buffer,
    storage: { snapshotRoot }
  })
  if (!ref) {
    throw new Error('Missing fixture snapshot')
  }
  expect(readTerminalScrollbackSnapshotSync(ref, { snapshotRoot }, { purpose: 'archive' })).toBe(
    buffer
  )
})
