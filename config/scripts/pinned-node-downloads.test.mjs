import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { copyPinnedNodeExecutable } from './pinned-node-downloads.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pinned-node-copy-'))
  directories.push(directory)
  const source = join(directory, 'host-node')
  const destination = join(directory, 'cache', 'bin', 'node')
  const bytes = Buffer.from('pinned executable bytes')
  writeFileSync(source, bytes, { mode: 0o600 })
  return { source, destination, bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}

it('copies only the exact pinned executable and makes the cached copy runnable on POSIX', async () => {
  const { source, destination, bytes, hash } = fixture()
  expect(await copyPinnedNodeExecutable(source, destination, hash)).toBe(true)
  expect(readFileSync(destination)).toEqual(bytes)
  if (process.platform !== 'win32') {
    expect(statSync(destination).mode & 0o777).toBe(0o755)
  }
})

it('falls back when the host executable differs from the pin without staging it', async () => {
  const { source, destination } = fixture()
  expect(await copyPinnedNodeExecutable(source, destination, '0'.repeat(64))).toBe(false)
  expect(existsSync(destination)).toBe(false)
})

it('falls back when the candidate executable is unavailable', async () => {
  const { source, destination, hash } = fixture()
  rmSync(source)
  expect(await copyPinnedNodeExecutable(source, destination, hash)).toBe(false)
  expect(existsSync(destination)).toBe(false)
})

it('falls back when the candidate cannot be read as an executable file', async () => {
  const { source, destination, hash } = fixture()
  rmSync(source)
  mkdirSync(source)
  expect(await copyPinnedNodeExecutable(source, destination, hash)).toBe(false)
  expect(existsSync(destination)).toBe(false)
})
