import { beforeEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { createWslDaemonTransport } from './wsl-daemon-transport'
import { runProcess } from '../../shared/child-process/run-process'
import { assertWslRuntimeDistroRunning } from './wsl-bun-runtime'
import { readWslDistributionIdentity } from './wsl-distribution-identity'
import { openWslDaemonConnectorStream } from './wsl-daemon-connector-stream'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('./wsl-bun-runtime', () => ({ assertWslRuntimeDistroRunning: vi.fn() }))
vi.mock('./wsl-distribution-identity', () => ({ readWslDistributionIdentity: vi.fn() }))
vi.mock('./wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))
vi.mock('../wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))
vi.mock('./wsl-daemon-connector-stream', () => ({ openWslDaemonConnectorStream: vi.fn() }))
const endpoint = {
  distro: 'Ubuntu',
  distributionId: 'registered-owner',
  userName: 'alice',
  userId: '1001',
  home: '/home/alice',
  envBinary: '/usr/bin/env',
  runtime: '/home/alice/runtime/bun',
  socket: '/home/alice/owner/d.sock',
  tokenPath: '/home/alice/owner/token'
}
const operation = () => ({ timeoutMs: 5000, signal: new AbortController().signal })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(readWslDistributionIdentity).mockResolvedValue(endpoint.distributionId)
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: 'token',
    stderr: '',
    timedOut: false
  })
  vi.mocked(openWslDaemonConnectorStream).mockImplementation(async () => new PassThrough())
})

it('pins both channels and token reads to the captured guest user without shell interpretation', async () => {
  const mutable = { ...endpoint }
  const transport = createWslDaemonTransport(mutable)
  mutable.userName = 'bob'
  expect(await transport.readToken(operation())).toBe('token')
  const control = await transport.connect('control', operation())
  const stream = await transport.connect('stream', operation())
  const specs = [
    vi.mocked(runProcess).mock.calls[0][0],
    ...vi.mocked(openWslDaemonConnectorStream).mock.calls.map(([spec]) => spec)
  ]
  for (const spec of specs) {
    expect(spec.args).toEqual(expect.arrayContaining(['-d', 'Ubuntu', '-u', 'alice', '--exec']))
    expect(spec.args).toEqual(
      expect.arrayContaining(['--no-env-file', '--config=/dev/null', '--no-install'])
    )
    expect(spec.args).toContain(JSON.stringify(endpoint))
    expect(spec.args).not.toContain('--')
  }
  expect(assertWslRuntimeDistroRunning).toHaveBeenCalledTimes(3)
  control.destroy()
  stream.destroy()
})

it('refuses a re-registered or stopped distro before spawning a connector or reading a token', async () => {
  const transport = createWslDaemonTransport(endpoint)
  vi.mocked(readWslDistributionIdentity).mockResolvedValue('replacement')
  await expect(transport.connect('control', operation())).rejects.toThrow('unverifiable')
  await expect(transport.readToken(operation())).rejects.toThrow('unverifiable')
  vi.mocked(assertWslRuntimeDistroRunning).mockRejectedValue(new Error('not running'))
  await expect(transport.connect('stream', operation())).rejects.toThrow('not running')
  expect(openWslDaemonConnectorStream).not.toHaveBeenCalled()
  expect(runProcess).not.toHaveBeenCalled()
})

it('does not include arbitrary guest stderr in token failure messages', async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'private credential content',
    timedOut: false
  })
  await expect(createWslDaemonTransport(endpoint).readToken(operation())).rejects.toThrow(
    'authentication token is unavailable'
  )
})

it('refuses malformed guest identity before any execution', () => {
  expect(() => createWslDaemonTransport({ ...endpoint, tokenPath: 'C:\\host-token' })).toThrow(
    'absolute guest paths'
  )
  expect(() => createWslDaemonTransport({ ...endpoint, userId: '' })).toThrow(
    'captured execution owner'
  )
  expect(runProcess).not.toHaveBeenCalled()
})
