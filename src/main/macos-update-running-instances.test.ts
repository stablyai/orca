import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMacUpdateRunningInstances,
  parseMacUpdateRunningInstances
} from './macos-update-running-instances'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

const executable = '/Applications/Orca Test.app/Contents/MacOS/Orca Test'

describe('macOS update running instances', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
  })

  it('excludes the current process from the native registry result', () => {
    expect(parseMacUpdateRunningInstances('[100,101,102]\n', 100)).toEqual([101, 102])
    expect(parseMacUpdateRunningInstances('[]\n', 100)).toEqual([])
  })

  it.each([
    'not JSON',
    '',
    '{}',
    'null',
    '[0]',
    '[-1]',
    '[1.5]',
    '["101"]',
    '[null]',
    '[9007199254740992]'
  ])('rejects invalid registry output: %s', (listing) => {
    expect(() => parseMacUpdateRunningInstances(listing, 100)).toThrow()
  })

  it.runIf(process.platform === 'darwin')(
    'passes the bundle path as an argument rather than executable script',
    async () => {
      const unusualExecutable = '/Applications/Orca "Test" $HOME.app/Contents/MacOS/Orca Test'
      runProcessMock.mockResolvedValue({ code: 0, stdout: '[]', timedOut: false })
      await expect(getMacUpdateRunningInstances(unusualExecutable)).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [
            '-l',
            'JavaScript',
            '-e',
            expect.not.stringContaining('$HOME'),
            '/Applications/Orca "Test" $HOME.app'
          ]
        })
      )
    }
  )

  it('skips development runtimes without probing the host', async () => {
    expect(await getMacUpdateRunningInstances('/usr/local/bin/node')).toEqual([])
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it.each(['linux', 'win32'])('does not probe on %s', async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    try {
      expect(await getMacUpdateRunningInstances(executable)).toEqual([])
      expect(runProcessMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.runIf(process.platform === 'darwin')(
    'uses the bounded native application registry query and preserves paths with spaces',
    async () => {
      runProcessMock.mockResolvedValue({
        code: 0,
        stdout: '[100,101]\n',
        timedOut: false
      })
      expect(await getMacUpdateRunningInstances(executable, 100)).toEqual([101])
      expect(runProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          program: '/usr/bin/osascript',
          args: [
            '-l',
            'JavaScript',
            '-e',
            expect.stringContaining('runningApplicationsWithBundleIdentifier'),
            '/Applications/Orca Test.app'
          ],
          timeoutMs: 5000,
          killOnOutputLimit: true
        })
      )
    }
  )

  it.runIf(process.platform === 'darwin').each([
    { code: 1, timedOut: false },
    { code: null, timedOut: true },
    { code: 0, timedOut: false, outputTruncated: true }
  ])('fails closed for incomplete query results: %j', async (result) => {
    runProcessMock.mockResolvedValue({ stdout: '', ...result })
    await expect(getMacUpdateRunningInstances(executable)).rejects.toThrow('Could not check')
  })
})
