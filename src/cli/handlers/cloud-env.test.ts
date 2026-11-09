import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_ENV_HANDLERS } from './cloud-env'
import type { HandlerContext } from '../dispatch'
import { CLOUD_ENVIRONMENT_METHODS } from '../../shared/hosted-sandbox/hosted-environment-cli-contract'

const ENV = { id: 'env_03b89d4bf1c74787a7ce', name: 'Web' }
const build = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'bld_0123456789abcdef',
  number: 7,
  status,
  active: false,
  durationMs: 61_000,
  failedStep: null,
  error: null,
  ...extra
})

function context(
  responder: (method: string, params: Record<string, unknown>) => unknown,
  flags: Record<string, string | boolean> = {}
): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    cwd: '/tmp',
    json: flags.json === true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cloud env handlers only use client.call
    client: {
      call: vi.fn(async (method: string, params: Record<string, unknown>) => ({
        id: '1',
        ok: true,
        result: responder(method, params),
        _meta: { runtimeId: 'r' }
      }))
    } as unknown as HandlerContext['client']
  }
}

let stdout: string
let stderr: string
beforeEach(() => {
  stdout = ''
  stderr = ''
  process.exitCode = undefined
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  vi.spyOn(console, 'log').mockImplementation((value) => {
    stdout += `${String(value)}\n`
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('orca cloud env build --wait', () => {
  it('streams the log and exits non-zero with the failed step', async () => {
    const polls = [
      {
        chunks: [{ stream: 'stdout', data: '::orca-step:: install\n' }],
        done: false,
        build: build('running')
      },
      {
        chunks: [{ stream: 'stderr', data: 'npm ERR! missing\n' }],
        done: true,
        build: build('failed', { failedStep: 'install', error: 'install_failed' })
      }
    ]
    let poll = 0
    const ctx = context(
      (method) => {
        if (method === CLOUD_ENVIRONMENT_METHODS.startBuild) {
          return { ok: true, data: { environment: ENV, build: build('running') } }
        }
        const next = polls[poll++]
        return {
          ok: true,
          data: { environment: ENV, cursor: poll, truncated: false, error: null, ...next }
        }
      },
      { wait: true }
    )
    await CLOUD_ENV_HANDLERS['cloud env build'](ctx)
    expect(stdout).toContain('::orca-step:: install')
    expect(stderr).toContain('npm ERR! missing')
    expect(stderr).toContain('Build #7 failed at the install step: install_failed.')
    expect(process.exitCode).toBe(1)
  })

  it('surfaces control-plane refusals as errors', async () => {
    const ctx = context(() => ({
      ok: false,
      error: {
        code: 'conflict',
        reason: 'build_in_progress',
        message: 'A build is already running.'
      }
    }))
    await expect(CLOUD_ENV_HANDLERS['cloud env build'](ctx)).rejects.toMatchObject({
      code: 'cloud_conflict',
      message: 'A build is already running.'
    })
  })
})
