import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFileDurable, writeFileDurableIfCurrent } from '../durable-file-write'

const rename = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  rename.mockImplementation(actual.rename)
  return { ...actual, rename }
})

const platform = process.platform
const roots: string[] = []
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  rename.mockClear()
  vi.restoreAllMocks()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-async-rename-'))
  roots.push(root)
  const target = join(root, 'state.json')
  const temporary = join(root, 'temporary.json')
  writeFileSync(target, 'old')
  return { root, target, temporary }
}

it.each(['EPERM', 'EACCES', 'EBUSY'])(
  'retries a transient Windows %s without blocking the event loop',
  async (code) => {
    const { target, temporary } = fixture()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    rename.mockRejectedValueOnce(Object.assign(new Error('file busy'), { code }))
    let ticked = false
    const timer = setTimeout(() => {
      ticked = true
    }, 0)
    try {
      await writeFileDurable(temporary, target, 'new')
      expect(readFileSync(target, 'utf8')).toBe('new')
      expect(rename).toHaveBeenCalledTimes(2)
      expect(ticked).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  }
)

it.each([
  ['win32', 'EPERM', 6],
  ['win32', 'ENOSPC', 1],
  ['linux', 'EBUSY', 1]
] as const)('bounds %s %s failures and preserves the old file', async (host, code, attempts) => {
  const { root, target, temporary } = fixture()
  Object.defineProperty(process, 'platform', { value: host })
  for (let attempt = 0; attempt < attempts; attempt++) {
    rename.mockRejectedValueOnce(Object.assign(new Error('injected file failure'), { code }))
  }
  await expect(writeFileDurable(temporary, target, 'new')).rejects.toThrow('injected file failure')
  expect(rename).toHaveBeenCalledTimes(attempts)
  expect(readFileSync(target, 'utf8')).toBe('old')
  expect(readdirSync(root)).toEqual(['state.json'])
})

it('does not publish a superseded snapshot after a Windows retry delay', async () => {
  const { root, target, temporary } = fixture()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let current = true
  rename.mockImplementationOnce(async () => {
    current = false
    writeFileSync(target, 'newer snapshot')
    throw Object.assign(new Error('busy'), { code: 'EBUSY' })
  })
  await expect(
    writeFileDurableIfCurrent(temporary, target, 'stale snapshot', () => current)
  ).resolves.toBe(false)
  expect(rename).toHaveBeenCalledOnce()
  expect(readFileSync(target, 'utf8')).toBe('newer snapshot')
  expect(readdirSync(root)).toEqual(['state.json'])
})
