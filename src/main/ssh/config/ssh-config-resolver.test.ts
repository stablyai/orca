import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWithSshG } from './ssh-g-config-resolution'
import { runProcess } from '@orca/process-host'

vi.mock('os', () => ({
  homedir: () => '/home/testuser'
}))

// Mock process-host: it owns hidden windows, timeout and argv encoding; this suite verifies routing.
vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn()
}))

const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: '', timedOut: false })

describe('resolveWithSshG', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns parsed config on success', async () => {
    vi.mocked(runProcess).mockResolvedValue(ok('hostname 10.0.0.1\nuser admin\nport 22'))

    const result = await resolveWithSshG('myhost')
    expect(result).toBeDefined()
    expect(result!.hostname).toBe('10.0.0.1')
    expect(result!.user).toBe('admin')
  })

  it('calls ssh -G with the given host under a bounded timeout', async () => {
    vi.mocked(runProcess).mockResolvedValue(ok('hostname example.com\nport 22'))

    await resolveWithSshG('testserver')
    expect(runProcess).toHaveBeenCalledWith({
      program: 'ssh',
      args: ['-G', '--', 'testserver'],
      timeoutMs: 5000
    })
  })

  it('returns null when ssh -G fails', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 255,
      signal: null,
      stdout: '',
      stderr: 'ssh not found',
      timedOut: false
    })

    expect(await resolveWithSshG('myhost')).toBeNull()
  })

  it('returns null when ssh -G could not be started', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('ENOENT'))

    expect(await resolveWithSshG('myhost')).toBeNull()
  })

  it('returns null when ssh -G never reports completion', async () => {
    // process-host returns timeout data; no fake timer is needed.
    vi.mocked(runProcess).mockResolvedValue({
      code: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true
    })

    expect(await resolveWithSshG('stuck-host')).toBeNull()
  })
})
