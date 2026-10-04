import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readRelayTranscriptBytes } from './ai-vault-transcript-stream'

const { afterLstat } = vi.hoisted(() => {
  const afterLstat: { run: null | (() => Promise<void>) } = { run: null }
  return { afterLstat }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const observed = await actual.lstat(...args)
      await afterLstat.run?.()
      return observed
    }
  }
})

let root = ''
let path = ''
beforeEach(async () => {
  root = await filesystem.mkdtemp(join(tmpdir(), 'rx-relay-admit-'))
  path = join(root, 'index.json')
  vi.mocked(filesystem.open).mockClear()
})
afterEach(async () => {
  afterLstat.run = null
  await filesystem.rm(root, { recursive: true, force: true })
})

async function read(signal?: AbortSignal, maxBytes = 64): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of readRelayTranscriptBytes(path, signal, {
    regularFileOnly: true,
    maxBytes
  })) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

it('uses the guarded descriptor for a bounded read after the path is replaced', async () => {
  await filesystem.writeFile(path, 'original')
  let observations = 0
  afterLstat.run = async () => {
    if (++observations !== 2) {
      return
    }
    afterLstat.run = null
    await filesystem.rename(path, join(root, 'saved.json'))
    await filesystem.writeFile(path, 'replacement')
  }
  expect(await read()).toBe('original')
  expect(filesystem.open).toHaveBeenCalledTimes(1)
  expect(await filesystem.readFile(path, 'utf8')).toBe('replacement')
})

it('rejects oversized and binary bounded metadata', async () => {
  await filesystem.writeFile(path, 'x'.repeat(65))
  await expect(read()).rejects.toThrow('File too large')
  await filesystem.writeFile(path, Buffer.from([0, 0, 0, 0]))
  await expect(read()).rejects.toThrow(/binary/i)
})

it.skipIf(process.platform === 'win32')(
  'retains nofollow admission for bounded metadata',
  async () => {
    const saved = join(root, 'saved.json')
    await filesystem.writeFile(saved, '{}')
    await filesystem.symlink(saved, path)
    await expect(read()).rejects.toThrow('regular file')
    expect(filesystem.open).not.toHaveBeenCalled()
  }
)

it('does not open when cancelled before admission', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(filesystem.open).not.toHaveBeenCalled()
})
