import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_DAEMON_CONTROL_FILE_BYTES,
  readDaemonControlFileText
} from './daemon-control-file-reader'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-daemon-control-'))
  roots.push(root)
  return join(root, 'control')
}

describe('readDaemonControlFileText', () => {
  it('accepts a control file exactly at the byte cap', () => {
    const filePath = createPath()
    writeFileSync(filePath, Buffer.alloc(MAX_DAEMON_CONTROL_FILE_BYTES, 0x61))

    expect(readDaemonControlFileText(filePath)).toHaveLength(MAX_DAEMON_CONTROL_FILE_BYTES)
  })

  it('rejects a sparse control file beyond the byte cap', () => {
    const filePath = createPath()
    const file = openSync(filePath, 'w')
    ftruncateSync(file, MAX_DAEMON_CONTROL_FILE_BYTES + 1)
    closeSync(file)

    expect(() => readDaemonControlFileText(filePath)).toThrow('exceeds')
  })
})
