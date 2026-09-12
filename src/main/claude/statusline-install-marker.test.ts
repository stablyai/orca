import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
    fstatSync: vi.fn(actual.fstatSync)
  }
})
import { readStatusLineInstallMarker } from './statusline-install-marker'
let dir: string
let path: string
const digest = 'a'.repeat(64)
const valid = JSON.stringify({ version: 1, commandSha256: digest })
beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs')
  for (const name of ['openSync', 'readSync', 'closeSync', 'fstatSync'] as const) {
    vi.mocked(fs[name])
      .mockReset()
      .mockImplementation(actual[name] as never)
  }
  dir = fs.mkdtempSync(join(tmpdir(), 'orca-marker-'))
  path = join(dir, 'marker')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

it.each([1023, 1024, 1025])('bounds actual I/O for %i bytes', (size) => {
  fs.writeFileSync(path, valid.padEnd(size))
  expect(readStatusLineInstallMarker(path)).toEqual(
    size <= 1024 ? { present: true, commandSha256: digest } : { present: true }
  )
  const lengths = vi.mocked(fs.readSync).mock.calls.map((call) => call[2]!.length!)
  expect(lengths.reduce((a, b) => a + b, 0)).toBe(size <= 1024 ? size : 0)
  expect(lengths.every((n) => n <= 1024)).toBe(true)
})

it.each([
  '',
  `${valid}garbage`,
  `${valid + ' '.repeat(1024)}garbage`,
  `{"version":2,"commandSha256":"${digest}"}`,
  JSON.stringify({ version: 1, commandSha256: digest, extra: true })
])('rejects uncertain metadata %j', (value) => {
  fs.writeFileSync(path, value)
  expect(readStatusLineInstallMarker(path)).toEqual({ present: true })
})

it('distinguishes absence, directory and dangling link without opening nonregular paths', () => {
  expect(readStatusLineInstallMarker(path)).toEqual({ present: false })
  fs.mkdirSync(path)
  expect(readStatusLineInstallMarker(path)).toEqual({ present: true })
  expect(fs.openSync).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')(
  'preserves dangling link opt-out without opening it',
  () => {
    fs.symlinkSync(join(dir, 'missing'), path)
    expect(readStatusLineInstallMarker(path)).toEqual({ present: true })
    expect(fs.openSync).not.toHaveBeenCalled()
  }
)

it('does not reinterpret a marker disappearing before open as first install', () => {
  fs.writeFileSync(path, valid)
  vi.mocked(fs.openSync).mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' })
  })
  expect(readStatusLineInstallMarker(path)).toEqual({ present: true })
})

it.each(['short', 'error', 'growth', 'close'] as const)(
  'handles %s reads conservatively',
  async (kind) => {
    fs.writeFileSync(path, valid)
    const actual = await vi.importActual<typeof fs>('node:fs')
    if (kind === 'short') {
      vi.mocked(fs.readSync).mockReturnValueOnce(0)
    }
    if (kind === 'error') {
      vi.mocked(fs.readSync).mockImplementationOnce(() => {
        throw new Error('read denied')
      })
    }
    if (kind === 'growth') {
      vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
        const count = actual.readSync(...args)
        fs.appendFileSync(path, 'bad')
        return count
      })
    }
    if (kind === 'close') {
      vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
        actual.closeSync(fd)
        throw new Error('close error')
      })
    }
    expect(readStatusLineInstallMarker(path)).toEqual(
      kind === 'close' ? { present: true, commandSha256: digest } : { present: true }
    )
    expect(fs.closeSync).toHaveBeenCalledTimes(1)
  }
)

it('completes short positive reads without exceeding the total byte budget', async () => {
  fs.writeFileSync(path, valid.padEnd(1024))
  const actual = await vi.importActual<typeof fs>('node:fs')
  let acquired = 0
  vi.mocked(fs.readSync).mockImplementation((fd, buffer, options) => {
    const count = actual.readSync(fd, buffer, {
      ...options,
      length: Math.min(options!.length!, 17)
    })
    acquired += count
    return count
  })
  expect(readStatusLineInstallMarker(path)).toEqual({ present: true, commandSha256: digest })
  expect(acquired).toBe(1024)
})
