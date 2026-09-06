import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  resolveSecretReferencesIntoChildEnv,
  SecretReferenceResolutionError
} from './resolve-agent-env-secret-references'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const runProcessMock = vi.mocked(runProcess)
const REFERENCE = 'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY'
const SENTINEL = 'sentinel-plaintext-secret'
const OK = {
  code: 0,
  signal: null,
  stdout: `${SENTINEL}\n`,
  stderr: '',
  timedOut: false,
  outputTruncated: false
} as const

describe('resolveSecretReferencesIntoChildEnv', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue(OK)
  })

  it('replaces only approved references after every read succeeds', async () => {
    const childEnv = { POSTHOG_READ_ONLY: REFERENCE, PATH: '/usr/bin' }

    await resolveSecretReferencesIntoChildEnv({
      childEnv,
      target: { ssh: false, wsl: false }
    })

    expect(childEnv).toEqual({ POSTHOG_READ_ONLY: SENTINEL, PATH: '/usr/bin' })
    expect(runProcessMock).toHaveBeenCalledWith({
      program: 'doppler',
      args: [
        'secrets',
        'get',
        'POSTHOG_READ_ONLY',
        '--project',
        'lets-tango',
        '--config',
        'dev_ops',
        '--plain'
      ],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  })

  it.each([
    ['ssh', { ssh: true, wsl: false }],
    ['wsl', { ssh: false, wsl: true }]
  ] as const)('rejects a %s target before reading a secret', async (_name, target) => {
    const childEnv = { POSTHOG_READ_ONLY: REFERENCE }

    await expect(resolveSecretReferencesIntoChildEnv({ childEnv, target })).rejects.toMatchObject({
      code: 'remote-target',
      envKey: 'POSTHOG_READ_ONLY'
    })
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(childEnv.POSTHOG_READ_ONLY).toBe(REFERENCE)
  })

  it.each([
    ['timeout', { ...OK, timedOut: true }],
    ['truncated', { ...OK, outputTruncated: true }],
    ['nonzero-exit', { ...OK, code: 1 }],
    ['empty-output', { ...OK, stdout: '\n' }]
  ] as const)('reports %s without exposing process output', async (code, result) => {
    runProcessMock.mockResolvedValue(result)
    const childEnv = { POSTHOG_READ_ONLY: REFERENCE }

    const rejection = resolveSecretReferencesIntoChildEnv({
      childEnv,
      target: { ssh: false, wsl: false }
    })

    await expect(rejection).rejects.toMatchObject({ code, envKey: 'POSTHOG_READ_ONLY' })
    await expect(rejection).rejects.not.toThrow(SENTINEL)
    expect(childEnv.POSTHOG_READ_ONLY).toBe(REFERENCE)
  })

  it('reports spawn failure without preserving the cause', async () => {
    runProcessMock.mockRejectedValue(new Error(SENTINEL))
    const childEnv = { POSTHOG_READ_ONLY: REFERENCE }

    let error: Error | undefined
    try {
      await resolveSecretReferencesIntoChildEnv({
        childEnv,
        target: { ssh: false, wsl: false }
      })
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause))
    }

    expect(error).toBeInstanceOf(SecretReferenceResolutionError)
    expect(error).toMatchObject({ code: 'spawn-failure', envKey: 'POSTHOG_READ_ONLY' })
    expect(String(error)).not.toContain(SENTINEL)
    expect(error?.cause).toBeUndefined()
  })

  it('does not apply partial values when a later read fails', async () => {
    runProcessMock
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce({ ...OK, stdout: SENTINEL, code: 1 })
    const childEnv = {
      POSTHOG_READ_ONLY: REFERENCE,
      LINEAR_API_KEY: 'doppler-ref://lets-tango/dev_ops/LINEAR_API_KEY'
    }

    await expect(
      resolveSecretReferencesIntoChildEnv({
        childEnv,
        target: { ssh: false, wsl: false }
      })
    ).rejects.toMatchObject({ code: 'nonzero-exit', envKey: 'LINEAR_API_KEY' })
    expect(childEnv).toEqual({
      POSTHOG_READ_ONLY: REFERENCE,
      LINEAR_API_KEY: 'doppler-ref://lets-tango/dev_ops/LINEAR_API_KEY'
    })
  })

  it('rejects invalid candidates before running Doppler', async () => {
    const childEnv = { HOME: 'doppler-ref://lets-tango/dev_ops/HOME' }

    await expect(
      resolveSecretReferencesIntoChildEnv({
        childEnv,
        target: { ssh: false, wsl: false }
      })
    ).rejects.toMatchObject({ code: 'invalid-reference', envKey: 'HOME' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects a destination-key mismatch before running Doppler', async () => {
    const childEnv = { LINEAR_API_KEY: REFERENCE }

    await expect(
      resolveSecretReferencesIntoChildEnv({
        childEnv,
        target: { ssh: false, wsl: false }
      })
    ).rejects.toMatchObject({ code: 'invalid-reference', envKey: 'LINEAR_API_KEY' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
