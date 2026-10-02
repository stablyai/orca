import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { classifyCodesignDisplayOutput, getDaemonMacCodeIdentity } from './daemon-mac-code-identity'

const HELPER_PATH =
  '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'
const PARKED_PATH =
  '/private/var/folders/x/T/com.stablyai.orca.ShipIt.abc/Orca.app/Contents/MacOS/Orca'

function codesignReturns(stderr: string, code: number | null, timedOut = false): void {
  runProcessMock.mockResolvedValue({ code, stdout: '', stderr, timedOut })
}

beforeEach(() => {
  runProcessMock.mockReset()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('classifyCodesignDisplayOutput', () => {
  it('resolves the executable path codesign reports for a live process', () => {
    expect(
      classifyCodesignDisplayOutput(
        `Executable=${HELPER_PATH}\nIdentifier=com.stablyai.orca.helper\nFormat=pid diskrep\n`,
        0
      )
    ).toBe('resolved')
  })

  it('separates the Squirrel staging copy from the installed bundle', () => {
    expect(classifyCodesignDisplayOutput(`Executable=${PARKED_PATH}\n`, 0)).toBe('parked')
    expect(
      classifyCodesignDisplayOutput(
        'Executable=/Users/a/Library/Caches/com.stablyai.orca.ShipIt/u/Orca.app/Contents/MacOS/Orca\n',
        0
      )
    ).toBe('parked')
  })

  it('treats the unlinked-executable diagnostic as unresolvable', () => {
    expect(classifyCodesignDisplayOutput('+3337: No such file or directory\n', 1)).toBe(
      'unresolvable'
    )
  })

  it('fails open on a dead pid, an exiting pid, unsigned code, or an unexpected failure', () => {
    expect(classifyCodesignDisplayOutput('+999999: No such process\n', 1)).toBe('probe-failed')
    // errSecCSNoSuchCode: proc_pidpath resolved, the pid is just on its way out.
    expect(
      classifyCodesignDisplayOutput('+3337: host has no guest with the requested attributes\n', 1)
    ).toBe('probe-failed')
    expect(classifyCodesignDisplayOutput('/opt/tool: code object is not signed at all\n', 1)).toBe(
      'probe-failed'
    )
    expect(classifyCodesignDisplayOutput('', null)).toBe('probe-failed')
  })

  it('does not read an unlinked diagnostic out of a successful display', () => {
    expect(
      classifyCodesignDisplayOutput(`Executable=${HELPER_PATH}\nNo such file or directory\n`, 0)
    ).toBe('resolved')
  })
})

describe('getDaemonMacCodeIdentity', () => {
  it('asks codesign to display the running pid and reads its stderr', async () => {
    codesignReturns(`Executable=${HELPER_PATH}\n`, 0)
    await expect(getDaemonMacCodeIdentity(3337)).resolves.toBe('resolved')
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/codesign',
        args: ['--display', '--verbose=1', '+3337']
      })
    )
  })

  it('reports unresolvable when codesign cannot map the pid to on-disk code', async () => {
    codesignReturns('+3337: No such file or directory\n', 1)
    await expect(getDaemonMacCodeIdentity(3337)).resolves.toBe('unresolvable')
  })

  it('reprobes on every ask rather than reporting an earlier verdict', async () => {
    codesignReturns(`Executable=${HELPER_PATH}\n`, 0)
    await getDaemonMacCodeIdentity(3337)
    await getDaemonMacCodeIdentity(3337)
    expect(runProcessMock).toHaveBeenCalledTimes(2)

    codesignReturns('+3337: No such file or directory\n', 1)
    await expect(getDaemonMacCodeIdentity(3337)).resolves.toBe('unresolvable')
  })

  it('discards a timed-out probe even when it printed a path first', async () => {
    codesignReturns('Executable=/x\n', null, true)
    await expect(getDaemonMacCodeIdentity(3337)).resolves.toBe('probe-failed')
  })

  it('coalesces concurrent asks about one pid into a single probe', async () => {
    codesignReturns(`Executable=${HELPER_PATH}\n`, 0)
    await expect(
      Promise.all([getDaemonMacCodeIdentity(3337), getDaemonMacCodeIdentity(3337)])
    ).resolves.toEqual(['resolved', 'resolved'])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('fails open when codesign cannot be spawned, off macOS, or without a pid', async () => {
    runProcessMock.mockRejectedValue(new Error('spawn ENOENT'))
    await expect(getDaemonMacCodeIdentity(3337)).resolves.toBe('probe-failed')

    runProcessMock.mockClear()
    await expect(getDaemonMacCodeIdentity(0)).resolves.toBe('probe-failed')
    await expect(getDaemonMacCodeIdentity(null)).resolves.toBe('probe-failed')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(getDaemonMacCodeIdentity(3337)).resolves.toBe('probe-failed')
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
