import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findConflictingAppInstancePids,
  parseRunningApplicationPids
} from './updater-conflicting-app-instances'

const ORCA_BIN = '/Applications/Orca.app/Contents/MacOS/Orca'
const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

beforeEach(() => {
  execFileMock.mockReset()
})

describe('parseRunningApplicationPids', () => {
  it('parses positive pids and excludes the current process', () => {
    expect(parseRunningApplicationPids('100\n 300\n', 100)).toEqual([300])
  })

  it('ignores malformed, negative, and zero rows', () => {
    expect(parseRunningApplicationPids('not-a-row\n-5\n0\n42extra', 1)).toEqual([])
  })
})

describe('findConflictingAppInstancePids', () => {
  it('reports other same-binary instances on darwin', async () => {
    let readerArgs: [string, number] | null = null
    const pids = await findConflictingAppInstancePids({
      platform: 'darwin',
      executablePath: ORCA_BIN,
      currentPid: 100,
      readRunningApplicationPids: async (executablePath, currentPid) => {
        readerArgs = [executablePath, currentPid]
        return '777'
      }
    })

    expect(pids).toEqual([777])
    expect(readerArgs).toEqual([ORCA_BIN, 100])
  })

  it('uses one bounded AppKit query with path arguments kept out of the script', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string) => void
      callback(null, '777\n')
    })

    const pids = await findConflictingAppInstancePids({
      platform: 'darwin',
      executablePath: ORCA_BIN,
      currentPid: 100
    })

    expect(pids).toEqual([777])
    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [file, args, options] = execFileMock.mock.calls[0]
    expect(file).toBe('/usr/bin/osascript')
    expect(args).toEqual([
      '-l',
      'JavaScript',
      '-e',
      expect.stringContaining('NSWorkspace.sharedWorkspace.runningApplications'),
      '--',
      ORCA_BIN,
      '100'
    ])
    expect(options).toEqual(expect.objectContaining({ timeout: 2_000, maxBuffer: 64 * 1024 }))
  })

  it('skips the check off darwin — Win/Linux installers own this', async () => {
    const pids = await findConflictingAppInstancePids({
      platform: 'win32',
      executablePath: ORCA_BIN,
      currentPid: 100,
      readRunningApplicationPids: async () => '777'
    })

    expect(pids).toEqual([])
  })

  it('fails open when the application query is unavailable', async () => {
    const pids = await findConflictingAppInstancePids({
      platform: 'darwin',
      executablePath: ORCA_BIN,
      currentPid: 100,
      readRunningApplicationPids: async () => {
        throw new Error('osascript timed out')
      }
    })

    expect(pids).toEqual([])
  })
})
