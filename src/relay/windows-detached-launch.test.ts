import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('node:module', () => ({ createRequire: () => native.load }))
import { launchDetachedWindowsRelay } from './windows-detached-launch'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process, 'arch', { value: 'arm64' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  vi.clearAllMocks()
})

function fixture(failAt = '') {
  const pointers = new Map<number, ArrayBufferView>()
  function ptr(view: ArrayBufferView): number {
    const pointer = pointers.size + 1
    pointers.set(pointer, view)
    return pointer
  }
  function view(pointer: number | bigint): DataView {
    const bytes = pointers.get(Number(pointer))
    if (!bytes) {
      throw new Error('Unknown pointer')
    }
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  function text(pointer: number): string {
    const bytes = pointers.get(pointer)
    if (!bytes) {
      throw new Error('Unknown pointer')
    }
    return new TextDecoder('utf-16le').decode(bytes).replace(/\0$/, '')
  }
  const files: string[] = []
  const api = {
    CreateFileW: vi.fn((path: number, _access: number, share: number, security: number) => {
      expect(view(security).getUint32(0, true)).toBe(24)
      expect(view(security).getUint32(16, true)).toBe(1)
      expect(share).toBe(7)
      files.push(text(path))
      return failAt === `file-${files.length}` ? 0xffff_ffff_ffff_ffffn : BigInt(100 + files.length)
    }),
    InitializeProcThreadAttributeList: vi.fn(
      (list: number | null, count: number, _flags: number, size: number) => {
        expect(count).toBe(1)
        view(size).setBigUint64(0, 64n, true)
        return list === null || failAt === 'initialize' ? 0 : 1
      }
    ),
    UpdateProcThreadAttribute: vi.fn(
      (_list: number, _flags: number, attribute: number, handles: number, size: number) => {
        expect(attribute).toBe(0x00020002)
        expect(size).toBe(24)
        expect([0, 8, 16].map((offset) => view(handles).getBigUint64(offset, true))).toEqual([
          101n,
          102n,
          103n
        ])
        return failAt === 'allowlist' ? 0 : 1
      }
    ),
    DeleteProcThreadAttributeList: vi.fn(),
    CreateProcessW: vi.fn(
      (
        application: number,
        command: number,
        _process: null,
        _thread: null,
        inherit: number,
        flags: number,
        environment: null,
        cwd: number,
        startup: number,
        result: number
      ) => {
        expect(text(application)).toBe('C:\\owned runtime\\bun.exe')
        expect(text(command)).toContain('"%USER% & name"')
        expect(text(cwd)).toBe('C:\\profile & space')
        expect(inherit).toBe(1)
        expect(flags).toBe(0x09080000)
        expect(environment).toBeNull()
        expect(view(startup).getUint32(0, true)).toBe(112)
        expect(view(startup).getUint32(60, true)).toBe(0x100)
        expect([80, 88, 96].map((offset) => view(startup).getBigUint64(offset, true))).toEqual([
          101n,
          102n,
          103n
        ])
        expect(view(startup).getBigUint64(104, true)).not.toBe(0n)
        if (failAt === 'spawn') {
          return 0
        }
        view(result).setBigUint64(0, 201n, true)
        view(result).setBigUint64(8, 202n, true)
        view(result).setUint32(16, 42, true)
        return 1
      }
    ),
    GetLastError: vi.fn(() => 5),
    CloseHandle: vi.fn()
  }
  const close = vi.fn()
  native.load.mockReturnValue({ ptr, dlopen: () => ({ symbols: api, close }) })
  return { api, files, close }
}
const options = {
  executable: 'C:\\owned runtime\\bun.exe',
  args: ['%USER% & name', 'tail\\'],
  cwd: 'C:\\profile & space',
  stdoutPath: 'C:\\stdout.log',
  stderrPath: 'C:\\stderr.log'
}
describe('Windows relay job breakaway', () => {
  it('uses direct argv and an explicit standard-stream allowlist, then closes parent handles', () => {
    const { api, files, close } = fixture()
    expect(launchDetachedWindowsRelay(options)).toBe(42)
    expect(files).toEqual(['NUL', options.stdoutPath, options.stderrPath])
    expect(api.CloseHandle.mock.calls.flat()).toEqual([202n, 201n, 103n, 102n, 101n])
    expect(api.DeleteProcThreadAttributeList).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
  it.each(['file-1', 'file-2', 'file-3', 'initialize', 'allowlist', 'spawn'])(
    'closes only acquired handles after %s fails',
    (failAt) => {
      const { api, close } = fixture(failAt)
      expect(() => launchDetachedWindowsRelay(options)).toThrow('Win32 last-error hint 5')
      const opened = failAt.startsWith('file-') ? Number(failAt.slice(5)) - 1 : 3
      expect(api.CloseHandle.mock.calls.flat()).toEqual(
        [101n, 102n, 103n].slice(0, opened).toReversed()
      )
      expect(api.DeleteProcThreadAttributeList).toHaveBeenCalledTimes(
        ['allowlist', 'spawn'].includes(failAt) ? 1 : 0
      )
      expect(close).toHaveBeenCalledOnce()
      if (failAt !== 'spawn') {
        expect(api.CreateProcessW).not.toHaveBeenCalled()
      }
    }
  )
  it('refuses NUL truncation and oversized commands before opening files', () => {
    const { api, close } = fixture()
    for (const args of [['bad\0argument'], ['a'.repeat(32768)]]) {
      expect(() => launchDetachedWindowsRelay({ ...options, args })).toThrow()
    }
    expect(api.CreateFileW).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(2)
  })
})
