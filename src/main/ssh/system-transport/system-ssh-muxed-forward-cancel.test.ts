import { describe, expect, it, vi, beforeEach } from 'vitest'

const { findSystemSshMock, runProcessMock } = vi.hoisted(() => ({
  findSystemSshMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

vi.mock('./system-ssh-binary', () => ({ findSystemSsh: findSystemSshMock }))

import {
  buildMuxedLocalForwardCancelArgs,
  cancelMuxedLocalForward
} from './system-ssh-muxed-forward-cancel'
import type { SshTarget } from '../../../shared/ssh-types'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

describe('system SSH muxed forward cancel', () => {
  beforeEach(() => {
    findSystemSshMock.mockReset().mockReturnValue(SYSTEM_SSH_PATH)
    runProcessMock.mockReset().mockResolvedValue({ code: 0, signal: null, stdout: '', stderr: '' })
  })

  it('asks the master to cancel this exact forward, before the ssh destination', () => {
    const args = buildMuxedLocalForwardCancelArgs(
      createTarget({ configHost: 'workbox', source: 'ssh-config' }),
      59418,
      '127.0.0.1',
      6768
    )

    const terminatorIdx = args.indexOf('--')
    const controlCommandIdx = args.indexOf('-O')
    expect(args[controlCommandIdx + 1]).toBe('cancel')
    expect(controlCommandIdx).toBeLessThan(terminatorIdx)
    expect(args.indexOf('-L')).toBeLessThan(terminatorIdx)
    expect(args).toContain('127.0.0.1:59418:127.0.0.1:6768')
    expect(args[terminatorIdx + 1]).toBe('workbox')
  })

  // Why: `-O` is a request to a control socket, so the forward's own `-S none` would refuse it.
  it('stays multiplexed where a forward process would not be', () => {
    const args = buildMuxedLocalForwardCancelArgs(createTarget(), 59418, '127.0.0.1', 6768)

    const disablesMuxing = args.some((arg, index) => arg === '-S' && args[index + 1] === 'none')
    expect(disablesMuxing).toBe(false)
  })

  it('reports the port released when the master dropped the forward', async () => {
    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      true
    )
    expect(runProcessMock.mock.calls.at(-1)?.[0]?.args).toContain('cancel')
  })

  // A master that never registered this spec, or no master at all: nothing was released.
  it('reports nothing released when ssh refuses the request', async () => {
    runProcessMock.mockResolvedValue({
      code: 255,
      signal: null,
      stdout: '',
      stderr: 'Control socket connect(/tmp/cm): No such file or directory'
    })

    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      false
    )
  })

  // Why: a refused cancel exits 0, so only its stderr tells the port apart from a released one.
  it('reports nothing released when the master refuses the spec but still exits 0', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr:
        'mux_client_forward: forwarding request failed: port not forwarded\nmuxclient: master cancel forward request failed\n'
    })

    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      false
    )
  })

  it('reports nothing released when ssh cannot be spawned at all', async () => {
    runProcessMock.mockRejectedValue(new Error('ENOENT'))

    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      false
    )
  })

  it('reports nothing released without a system ssh binary', async () => {
    findSystemSshMock.mockReturnValue(null)

    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      false
    )
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
