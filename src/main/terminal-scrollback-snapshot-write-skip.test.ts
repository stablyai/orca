import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteTerminalScrollbackSnapshotSync,
  readTerminalScrollbackSnapshotSync,
  resetTerminalScrollbackSnapshotWriteMemoryForTest,
  writeTerminalScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'

/**
 * `setLocalWorkspaceSession` republishes every retained scrollback buffer on any layout change,
 * so an unchanged buffer used to be re-encoded and rewritten on every pane focus change.
 */
describe('terminal scrollback snapshot write skipping', () => {
  let snapshotRoot: string

  const storage = (): { snapshotRoot: string; fallbackSnapshotRoot: null } => ({
    snapshotRoot,
    fallbackSnapshotRoot: null
  })

  const snapshotFiles = (): string[] =>
    readdirSync(snapshotRoot).filter((name) => !name.endsWith('.tmp'))

  const onlySnapshotStat = (): Stats => {
    const files = snapshotFiles()
    expect(files).toHaveLength(1)
    return statSync(join(snapshotRoot, files[0]))
  }

  beforeEach(() => {
    snapshotRoot = mkdtempSync(join(tmpdir(), 'orca-scrollback-write-skip-'))
    resetTerminalScrollbackSnapshotWriteMemoryForTest()
  })

  afterEach(() => {
    rmSync(snapshotRoot, { recursive: true, force: true })
    resetTerminalScrollbackSnapshotWriteMemoryForTest()
  })

  it('does not touch the file when the same buffer is republished', () => {
    const args = { tabId: 'tab-1', leafId: 'leaf-1', buffer: 'hello world\n', storage: storage() }

    const ref = writeTerminalScrollbackSnapshotSync(args)
    const first = onlySnapshotStat()

    expect(writeTerminalScrollbackSnapshotSync(args)).toBe(ref)
    const second = onlySnapshotStat()

    expect(second.mtimeMs).toBe(first.mtimeMs)
    expect(second.ino).toBe(first.ino)
    expect(readTerminalScrollbackSnapshotSync(ref!, storage())).toBe('hello world\n')
  })

  it('writes again when the buffer content changes', () => {
    const base = { tabId: 'tab-1', leafId: 'leaf-1', storage: storage() }

    const ref = writeTerminalScrollbackSnapshotSync({ ...base, buffer: 'first\n' })
    writeTerminalScrollbackSnapshotSync({ ...base, buffer: 'second\n' })

    expect(readTerminalScrollbackSnapshotSync(ref!, storage())).toBe('second\n')
  })

  it('writes again after the snapshot is deleted', () => {
    const args = { tabId: 'tab-1', leafId: 'leaf-1', buffer: 'hello\n', storage: storage() }
    const ref = writeTerminalScrollbackSnapshotSync(args)

    deleteTerminalScrollbackSnapshotSync(ref!, storage())
    expect(snapshotFiles()).toHaveLength(0)

    expect(writeTerminalScrollbackSnapshotSync(args)).toBe(ref)
    expect(readTerminalScrollbackSnapshotSync(ref!, storage())).toBe('hello\n')
  })

  it('rewrites when an external writer replaced the file and the buffer then changes', () => {
    const base = { tabId: 'tab-1', leafId: 'leaf-1', storage: storage() }
    const ref = writeTerminalScrollbackSnapshotSync({ ...base, buffer: 'orca\n' })
    writeFileSync(join(snapshotRoot, snapshotFiles()[0]), 'external\n')

    writeTerminalScrollbackSnapshotSync({ ...base, buffer: 'orca again\n' })

    expect(readTerminalScrollbackSnapshotSync(ref!, storage())).toBe('orca again\n')
  })
})
