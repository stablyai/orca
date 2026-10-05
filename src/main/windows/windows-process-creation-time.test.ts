import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  __setWindowsProcessTreeLoaderForTests,
  __setWindowsProcessTreeRequireForTests,
  readWindowsProcessCreationTime
} from './windows-process-table'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const read = vi.fn<(pid: number) => number | undefined>()
const scan = vi.fn()

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  read.mockReset().mockReturnValue(1_700_000_000_000)
  scan.mockReset()
  __setWindowsProcessTreeLoaderForTests(() => ({
    ProcessDataFlag: { None: 0, CommandLine: 2, CreationTime: 4 },
    getAllProcesses: scan,
    getProcessCreationTime: read
  }))
})

afterEach(() => {
  __setWindowsProcessTreeRequireForTests()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

it('reads one PID afresh on each call without enumerating the table', () => {
  expect(readWindowsProcessCreationTime(12)).toBe(1_700_000_000_000)
  read.mockReturnValue(1_800_000_000_000)
  expect(readWindowsProcessCreationTime(12)).toBe(1_800_000_000_000)
  expect(read.mock.calls).toEqual([[12], [12]])
  expect(scan).not.toHaveBeenCalled()
})

it.each([undefined, 0, -1, Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'keeps an unavailable or invalid native creation time unverifiable: %s',
  (value) => {
    read.mockReturnValue(value)
    expect(readWindowsProcessCreationTime(12)).toBeNull()
  }
)

it.each([0, -1, Number.NaN, Infinity, 1.5, 0x100000000])('refuses an invalid PID %s', (pid) => {
  expect(readWindowsProcessCreationTime(pid)).toBeNull()
  expect(read).not.toHaveBeenCalled()
})

it('keeps denied or failed native queries unverifiable', () => {
  read.mockImplementation(() => {
    throw Object.assign(new Error('access denied'), { code: 'EPERM' })
  })
  expect(readWindowsProcessCreationTime(12)).toBeNull()
})

it('does not invoke the reader off Windows', () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  expect(readWindowsProcessCreationTime(12)).toBeNull()
  expect(read).not.toHaveBeenCalled()
})

it.each([true, false])('does not scan or fork when native capability is missing: %s', (loaded) => {
  __setWindowsProcessTreeLoaderForTests(() =>
    loaded
      ? {
          ProcessDataFlag: { None: 0, CommandLine: 2, CreationTime: 4 },
          supportedProcessDataFlags: 7,
          getAllProcesses: scan
        }
      : null
  )
  expect(readWindowsProcessCreationTime(12)).toBeNull()
  expect(scan).not.toHaveBeenCalled()
})

it('adapts the same identity getter from the staged relay addon', () => {
  __setWindowsProcessTreeRequireForTests((specifier) => {
    if (specifier === '@vscode/windows-process-tree') {
      throw new Error('no package')
    }
    return { getProcessList: scan, getProcessCreationTime: read }
  })
  expect(readWindowsProcessCreationTime(12)).toBe(1_700_000_000_000)
  expect(read).toHaveBeenCalledWith(12)
  expect(scan).not.toHaveBeenCalled()
})
