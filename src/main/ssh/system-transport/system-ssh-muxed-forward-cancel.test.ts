import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { findSystemSshMock, runProcessMock } = vi.hoisted(() => ({
  findSystemSshMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

vi.mock('./system-ssh-binary', () => ({ findSystemSsh: findSystemSshMock }))

import {
  buildControlPathQueryArgs,
  buildMuxedLocalForwardCancelArgs,
  cancelMuxedLocalForward
} from './system-ssh-muxed-forward-cancel'

import type { SshTarget } from '../../../shared/ssh-types'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

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

const ok = (stdout = '', stderr = '') => ({ code: 0, signal: null, stdout, stderr })
const controlPathAnswer = ok('user deploy\ncontrolpath /tmp/cm-abc123\nport 22\n')

function cancelCall() {
  return runProcessMock.mock.calls.find(([request]) => request.args.includes('cancel'))?.[0]
}

describe('system SSH muxed forward cancel', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    findSystemSshMock.mockReset().mockReturnValue('/usr/bin/ssh')
    runProcessMock
      .mockReset()
      .mockImplementation(async (request: { args: string[] }) =>
        request.args[0] === '-G' ? controlPathAnswer : ok()
      )
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('reads the control socket with the target’s own args, multiplexed', () => {
    const args = buildControlPathQueryArgs(
      createTarget({ configHost: 'workbox', source: 'ssh-config' })
    )
    expect(args[0]).toBe('-G')
    expect(args.at(-1)).toBe('workbox')
    expect(args.some((arg, index) => arg === '-S' && args[index + 1] === 'none')).toBe(false)
  })

  // Why: `-O cancel` also cancels every forward a loaded ssh_config declares for the host.
  it('asks that socket to cancel only this exact forward, reading no ssh_config', () => {
    const args = buildMuxedLocalForwardCancelArgs(
      '/tmp/my sockets/cm-50%',
      59418,
      '127.0.0.1',
      6768
    )
    expect(args.slice(0, 2)).toEqual(['-F', '/dev/null'])
    expect(args[args.indexOf('-S') + 1]).toBe('/tmp/my sockets/cm-50%%')
    expect(args.indexOf('-O')).toBeLessThan(args.indexOf('--'))
    expect(args[args.indexOf('-O') + 1]).toBe('cancel')
    expect(args.filter((arg) => arg === '-L')).toHaveLength(1)
    expect(args).toContain('127.0.0.1:59418:127.0.0.1:6768')
  })

  it('asks nothing when the target has no control socket', async () => {
    runProcessMock.mockResolvedValue(ok('controlpath none\n'))
    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      false
    )
    expect(cancelCall()).toBeUndefined()
  })

  // Why: a refused cancel exits 0, so only its stderr tells the port apart from a released one.
  it('reports nothing released when the master refuses the spec but still exits 0', async () => {
    runProcessMock.mockImplementation(async (request: { args: string[] }) =>
      request.args[0] === '-G'
        ? controlPathAnswer
        : ok(
            '',
            'mux_client_forward: forwarding request failed: port not forwarded\nmuxclient: master cancel forward request failed\n'
          )
    )
    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      false
    )
  })

  it('asks no master on Windows, whose OpenSSH cannot multiplex', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await expect(cancelMuxedLocalForward(createTarget(), 59418, '127.0.0.1', 6768)).resolves.toBe(
      false
    )
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
