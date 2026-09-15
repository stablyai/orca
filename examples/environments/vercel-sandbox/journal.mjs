import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function readBytes(path) {
  try {
    return readFileSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}
export function atomicWrite(path, data, expected = null) {
  const before = readBytes(path)
  if ((before && hash(before)) !== expected) {
    throw new Error('STALE_PRECONDITION')
  }
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if ((readBytes(path) && hash(readBytes(path))) !== expected) {
    unlinkSync(temp)
    throw new Error('STALE_PRECONDITION')
  }
  renameSync(temp, path)
}

export function openJournal(directory, id, initial) {
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    throw new Error('Invalid journal ID')
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${id}.json`)
  const lock = `${path}.lock`
  const fd = openSync(lock, 'wx', 0o600)
  writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  closeSync(fd)
  try {
    let bytes = readBytes(path)
    let value = bytes ? JSON.parse(bytes) : initial
    if (!value) {
      throw new Error(`Journal missing: ${id}`)
    }
    return {
      get value() {
        return value
      },
      save(next) {
        const data = `${JSON.stringify(next, null, 2)}\n`
        atomicWrite(path, data, bytes && hash(bytes))
        const receipt = {
          at: new Date().toISOString(),
          actor: 'orca-vercel-recipe',
          reason: next.phase,
          target: path,
          before: bytes && hash(bytes),
          after: hash(data),
          result: 'WRITE_COMMITTED'
        }
        writeFileSync(
          join(directory, `${id}.${randomUUID()}.receipt.json`),
          JSON.stringify(receipt),
          { flag: 'wx', mode: 0o600 }
        )
        bytes = Buffer.from(data)
        value = next
      },
      close() {
        unlinkSync(lock)
      }
    }
  } catch (error) {
    unlinkSync(lock)
    throw error
  }
}
