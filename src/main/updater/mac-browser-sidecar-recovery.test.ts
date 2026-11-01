import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeMacUpdateBlockers,
  recoverMacBrowserSidecars
} from './mac-browser-sidecar-recovery'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: run }))

const executable = '/Applications/Orca Test.app/Contents/MacOS/Orca Test'
const command = `${
  executable
} --serve --serve-port 5000 --serve-json --serve-no-pairing --user-data-dir=/tmp/orcad-browser-test`
const startedAt = 'Tue Oct 13 21:00:00 2026'
const actualUid = process.getuid?.() ?? 501
const row = { pid: 123, parentPid: 1, uid: 501, startedAt, command }

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', getuid: () => 501 })
  run.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

function setup() {
  return {
    readProcesses: vi.fn().mockResolvedValue([row]),
    isOwnedSidecar: vi.fn().mockResolvedValue(true),
    signal: vi.fn(),
    listBlockers: vi.fn().mockResolvedValue([]),
    sleep: vi.fn().mockResolvedValue(undefined)
  }
}

describe('macOS browser leftovers during updates', () => {
  it('gracefully stops only verified orphan browser children and rechecks the native registry', async () => {
    const deps = setup()
    deps.listBlockers.mockResolvedValueOnce([123, 456]).mockResolvedValue([456])
    expect(await recoverMacBrowserSidecars(executable, [123, 456], deps)).toEqual([456])
    expect(deps.signal).toHaveBeenCalledExactlyOnceWith(123)
    expect(deps.readProcesses.mock.calls).toEqual([[[123, 456]], [[123]]])
    expect(deps.isOwnedSidecar).toHaveBeenCalledWith('/tmp/orcad-browser-test', 123, 501)
    expect(deps.listBlockers).toHaveBeenCalledTimes(2)
  })

  it.each([
    { ...row, parentPid: 42 },
    { ...row, uid: 999 },
    { ...row, pid: 456 },
    { ...row, command: executable },
    { ...row, command: command.replace('/tmp/orcad-browser-test', '/tmp/user-server') },
    { ...row, command: `${command} --extra-option` },
    { ...row, command: command.replace(executable, '/Applications/Other.app/Contents/MacOS/Other') }
  ])('leaves live, foreign, ordinary and ambiguous processes alone: %j', async (candidate) => {
    const deps = setup()
    deps.readProcesses.mockResolvedValue([candidate])
    expect(await recoverMacBrowserSidecars(executable, [123], deps)).toEqual([123])
    expect(deps.signal).not.toHaveBeenCalled()
  })

  it('leaves an orphan alone when its profile cannot prove ownership', async () => {
    const deps = setup()
    deps.isOwnedSidecar.mockResolvedValue(false)
    expect(await recoverMacBrowserSidecars(executable, [123], deps)).toEqual([123])
    expect(deps.signal).not.toHaveBeenCalled()
  })

  it.each([
    { rows: [] },
    { rows: [{ ...row, parentPid: 2 }] },
    { rows: [{ ...row, startedAt: 'Tue Oct 13 21:01:00 2026' }] },
    { rows: [{ ...row, command: executable }] }
  ])('rechecks the process identity after reading metadata: %j', async ({ rows: changed }) => {
    const deps = setup()
    deps.readProcesses.mockResolvedValueOnce([row]).mockResolvedValueOnce(changed)
    expect(await recoverMacBrowserSidecars(executable, [123], deps)).toEqual([123])
    expect(deps.signal).not.toHaveBeenCalled()
  })

  it('does not force kill a server that refuses to exit', async () => {
    const deps = setup()
    deps.listBlockers.mockResolvedValue([123])
    expect(await recoverMacBrowserSidecars(executable, [123], deps)).toEqual([123])
    expect(deps.signal).toHaveBeenCalledTimes(1)
    expect(deps.sleep).toHaveBeenCalledTimes(20)
  })

  it('does not interpret inspection or signal failures as exit', async () => {
    const deps = setup()
    deps.readProcesses.mockRejectedValueOnce(new Error('ps unavailable'))
    expect(await recoverMacBrowserSidecars(executable, [123], deps)).toEqual([123])
    deps.signal.mockImplementation(() => {
      throw new Error('EPERM')
    })
    expect(await recoverMacBrowserSidecars(executable, [123], deps)).toEqual([123])
  })

  it('fails closed if the native registry cannot recheck after signalling', async () => {
    const deps = setup()
    deps.listBlockers.mockRejectedValue(new Error('registry unavailable'))
    await expect(recoverMacBrowserSidecars(executable, [123], deps)).rejects.toThrow(
      'registry unavailable'
    )
  })

  it.each(['linux', 'win32'])('does not inspect or signal on %s', async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    const deps = setup()
    expect(await recoverMacBrowserSidecars(executable, [123], deps)).toEqual([123])
    expect(deps.readProcesses).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32').each([123, 999, '123', null])(
    'validates the real profile metadata before recovery (%s)',
    async (pid) => {
      const profile = await mkdtemp('/tmp/orcad-browser-')
      try {
        await writeFile(join(profile, 'orca-runtime.json'), JSON.stringify({ pid }))
        vi.stubGlobal('process', { ...process, getuid: () => actualUid })
        const deps = setup()
        deps.readProcesses.mockResolvedValue([
          { ...row, uid: actualUid, command: command.replace('/tmp/orcad-browser-test', profile) }
        ])
        const { isOwnedSidecar: _mockedVerifier, ...realVerification } = deps
        void _mockedVerifier
        expect(await recoverMacBrowserSidecars(executable, [123], realVerification)).toEqual(
          pid === 123 ? [] : [123]
        )
        expect(deps.signal).toHaveBeenCalledTimes(pid === 123 ? 1 : 0)
      } finally {
        await rm(profile, { recursive: true, force: true })
      }
    }
  )

  it('classifies servers and windows without shell parsing or signalling', async () => {
    run.mockResolvedValue({
      code: 0,
      stdout: [
        `123 1 501 ${startedAt} ${command}`,
        `456 42 501 ${startedAt} ${executable} --serve --user-data-dir=/Users/me/server`,
        `789 1 501 ${startedAt} ${executable}`
      ].join('\n')
    })
    expect(await describeMacUpdateBlockers(executable, [123, 456, 789, 999])).toEqual([
      { pid: 123, kind: 'browser' },
      { pid: 456, kind: 'server' },
      { pid: 789, kind: 'window' },
      { pid: 999, kind: 'unknown' }
    ])
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/bin/ps',
        args: ['-ww', '-p', '123,456,789,999', '-o', 'pid=,ppid=,uid=,lstart=,command=']
      })
    )
  })
})
