import { describe, expect, it, vi } from 'vitest'
import {
  inspectMacProcessCodeIdentity,
  parseCodesignDisplayOutput
} from './daemon-mac-code-identity'

const HELPER_PATH =
  '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'

describe('parseCodesignDisplayOutput', () => {
  it('resolves the executable path codesign reports for a live process', () => {
    expect(
      parseCodesignDisplayOutput(
        `Executable=${HELPER_PATH}\nIdentifier=com.stablyai.orca.helper\nFormat=pid diskrep\n`,
        0
      )
    ).toEqual({ status: 'resolved', executablePath: HELPER_PATH })
  })

  it('reads the parked path after Squirrel renames the bundle out of /Applications', () => {
    const parked = `/private/var/folders/x/T/com.stablyai.orca.ShipIt.abc/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper`
    expect(parseCodesignDisplayOutput(`Executable=${parked}\n`, 0)).toEqual({
      status: 'resolved',
      executablePath: parked
    })
  })

  it('treats the unlinked-executable diagnostic as unresolvable', () => {
    expect(parseCodesignDisplayOutput('+3337: No such file or directory\n', 1)).toEqual({
      status: 'unresolvable'
    })
  })

  it('fails open on a dead pid, an exiting pid, unsigned code, or an unexpected failure', () => {
    expect(parseCodesignDisplayOutput('+999999: No such process\n', 1)).toEqual({
      status: 'unavailable'
    })
    // errSecCSNoSuchCode: proc_pidpath resolved, the pid is just on its way out.
    expect(
      parseCodesignDisplayOutput('+3337: host has no guest with the requested attributes\n', 1)
    ).toEqual({ status: 'unavailable' })
    expect(parseCodesignDisplayOutput('/opt/tool: code object is not signed at all\n', 1)).toEqual({
      status: 'unavailable'
    })
    expect(parseCodesignDisplayOutput('', null)).toEqual({ status: 'unavailable' })
  })

  it('does not read an unlinked diagnostic out of a successful display', () => {
    expect(
      parseCodesignDisplayOutput(`Executable=${HELPER_PATH}\nNo such file or directory\n`, 0)
    ).toEqual({ status: 'resolved', executablePath: HELPER_PATH })
  })
})

describe('inspectMacProcessCodeIdentity', () => {
  it('asks codesign to display the running pid and parses its stderr', async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: '',
      stderr: `Executable=${HELPER_PATH}\n`
    }))
    await expect(inspectMacProcessCodeIdentity(3337, runCommand)).resolves.toEqual({
      status: 'resolved',
      executablePath: HELPER_PATH
    })
    expect(runCommand).toHaveBeenCalledWith(
      '/usr/bin/codesign',
      ['--display', '--verbose=1', '+3337'],
      expect.any(Number)
    )
  })

  it('reports unresolvable when codesign cannot map the pid to on-disk code', async () => {
    await expect(
      inspectMacProcessCodeIdentity(3337, async () => ({
        code: 1,
        stdout: '',
        stderr: '+3337: No such file or directory\n'
      }))
    ).resolves.toEqual({ status: 'unresolvable' })
  })

  it('fails open on an exiting pid rather than calling it severed', async () => {
    await expect(
      inspectMacProcessCodeIdentity(3337, async () => ({
        code: 1,
        stdout: '',
        stderr: '+3337: host has no guest with the requested attributes\n'
      }))
    ).resolves.toEqual({ status: 'unavailable' })
  })

  it('fails open when codesign cannot be spawned or the pid is invalid', async () => {
    await expect(
      inspectMacProcessCodeIdentity(3337, async () => {
        throw new Error('spawn ENOENT')
      })
    ).resolves.toEqual({ status: 'unavailable' })
    const runCommand = vi.fn()
    await expect(inspectMacProcessCodeIdentity(0, runCommand)).resolves.toEqual({
      status: 'unavailable'
    })
    expect(runCommand).not.toHaveBeenCalled()
  })
})
