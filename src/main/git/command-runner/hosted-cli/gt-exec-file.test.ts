import { afterEach, describe, expect, it, vi } from 'vitest'

const { captureMock } = vi.hoisted(() => ({
  captureMock: vi.fn(
    async (
      _binary: string,
      _args: string[],
      _options: { env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal }
    ) => ({
      stdout: '[]',
      stderr: ''
    })
  )
}))

vi.mock('../process-capture/exec-file-capture', () => ({
  execFileCaptureToTermination: captureMock
}))

import { gtExecFileAsync } from './gt-exec-file'

describe('gtExecFileAsync', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    captureMock.mockClear()
  })

  it('runs gt with non-interactive flags and defaults', async () => {
    captureMock.mockResolvedValueOnce({ stdout: '[{"id":1}]', stderr: '' })

    const res = await gtExecFileAsync(['issue', 'list', '--json', 'id'])
    expect(res.stdout).toBe('[{"id":1}]')

    expect(captureMock).toHaveBeenCalledTimes(1)
    const [binary, args, options] = captureMock.mock.calls[0]!
    expect(binary).toBe('gt')
    expect(args).toEqual(['issue', 'list', '--json', 'id'])
    expect(options.env).toMatchObject({
      NO_COLOR: '1',
      GITEA_CLI_ERROR_FORMAT: 'json',
      GITEA_CLI_NO_UPDATE_NOTIFIER: '1',
      GITEA_CLI_NO_EXTENSIONS: '1'
    })
  })

  it('decorates options.host and options.repo into arguments when missing', async () => {
    captureMock.mockResolvedValueOnce({ stdout: 'ok', stderr: '' })

    await gtExecFileAsync(['issue', 'list'], {
      host: 'https://gitea.example.com',
      repo: 'acme/widgets'
    })

    const [, args] = captureMock.mock.calls[0]!
    expect(args).toEqual([
      '--repo',
      'acme/widgets',
      '--host',
      'https://gitea.example.com',
      'issue',
      'list'
    ])
  })

  it('does not duplicate --host or --repo if already present in args', async () => {
    captureMock.mockResolvedValueOnce({ stdout: 'ok', stderr: '' })

    await gtExecFileAsync(['issue', 'list', '--host', 'https://other.com', '-R', 'other/repo'], {
      host: 'https://gitea.example.com',
      repo: 'acme/widgets'
    })

    const [, args] = captureMock.mock.calls[0]!
    expect(args).toEqual(['issue', 'list', '--host', 'https://other.com', '-R', 'other/repo'])
  })

  it('maps ORCA_GITEA_TOKEN and ORCA_GITEA_API_BASE_URL to Gitea CLI env vars', async () => {
    vi.stubEnv('ORCA_GITEA_TOKEN', 'token-123')
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://gitea.internal')

    await gtExecFileAsync(['auth', 'status'])

    const [, , options] = captureMock.mock.calls[0]!
    expect(options.env?.GITEA_TOKEN).toBe('token-123')
    expect(options.env?.GITEA_CLI_HOST).toBe('https://gitea.internal')
    expect(options.env?.GITEA_INSTANCE_URL).toBe('https://gitea.internal')
  })

  it('retries idempotent commands on transient errors', async () => {
    captureMock
      .mockRejectedValueOnce(new Error('ECONNRESET: socket hang up'))
      .mockResolvedValueOnce({ stdout: 'success', stderr: '' })

    const res = await gtExecFileAsync(['issue', 'list'], { idempotent: true })
    expect(res.stdout).toBe('success')
    expect(captureMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-idempotent commands on transient errors', async () => {
    captureMock.mockRejectedValueOnce(new Error('ECONNRESET: socket hang up'))

    await expect(gtExecFileAsync(['issue', 'create'], { idempotent: false })).rejects.toThrow(
      'ECONNRESET: socket hang up'
    )
    expect(captureMock).toHaveBeenCalledTimes(1)
  })
})
