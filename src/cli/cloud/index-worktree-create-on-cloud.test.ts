import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, runtimeClientConstructorMock, serveOrcaAppMock, getDefaultUserDataPathMock } =
  vi.hoisted(() => ({
    callMock: vi.fn(),
    runtimeClientConstructorMock: vi.fn(),
    serveOrcaAppMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('../runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

import { main } from '../index'

let home: string
let out: string[]
let err: string[]
let stdoutSpy: { mock: { calls: unknown[][] }; mockClear: () => void }
/** Everything the CLI printed: console.log lines plus raw stdout writes. */
const printed = () => out.join('') + stdoutSpy.mock.calls.map((call) => String(call[0])).join('')
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-cloud-main-'))
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)))
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.stubEnv('ORCA_CLOUD_CREDENTIALS_FILE', join(home, 'credentials.json'))
  vi.stubEnv('ORCA_CLOUD_TOKEN', 'orca_ws_test')
  vi.stubEnv('ORCA_CLOUD_API_URL', 'https://cloud.test')
  vi.stubGlobal('fetch', fetchMock)
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  runtimeClientConstructorMock.mockReset()
  rmSync(home, { recursive: true, force: true })
  process.exitCode = undefined
})

describe('orca worktree create --on cloud via main()', () => {
  it('creates an Orca Cloud workspace through the API, without the Orca runtime', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { workspace: { id: 'sbx_on1', name: 'fix', status: 'running', origin: 'vm' } },
        { status: 201 }
      )
    )
    await main(
      [
        'worktree',
        'create',
        '--on',
        'cloud',
        '--name',
        'fix',
        '--repo',
        'https://github.com/acme/app',
        '--agent',
        'claude',
        '--prompt',
        'hi',
        '--json'
      ],
      home
    )
    expect(process.exitCode).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://cloud.test/v1/workspaces')
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'fix',
      repo: { url: 'https://github.com/acme/app' },
      message: { text: 'hi', agent: 'claude' }
    })
    expect(JSON.parse(printed())).toMatchObject({
      ok: true,
      schemaVersion: 1,
      result: { host: { id: 'sbx_on1', origin: { target: 'cloud' } } }
    })
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('boots from a team environment with --env and reports a clear error for bad ids', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { workspace: { id: 'sbx_on2', name: 'e', status: 'running', origin: 'api' } },
        { status: 201 }
      )
    )
    await main(
      [
        'worktree',
        'create',
        '--on',
        'cloud',
        '--repo',
        'https://github.com/acme/app',
        '--env',
        'env_abcd1234',
        '--json'
      ],
      home
    )
    expect(process.exitCode).toBeUndefined()
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({ environment: 'env_abcd1234' })
    fetchMock.mockReset()
    out = []
    stdoutSpy.mockClear()
    await main(['worktree', 'create', '--on', 'cloud', '--env', 'prod', '--json'], home)
    expect(process.exitCode).not.toBeUndefined()
    expect(JSON.parse(printed())).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      { error: 'entitlement_denied', reason: 'concurrency_limit' },
      'cloud_at_capacity',
      "team's limit of running sandboxes"
    ],
    [
      { error: 'entitlement_denied', reason: 'no_subscription' },
      'cloud_plan_required',
      'needs a Team plan'
    ],
    [
      { error: 'entitlement_denied', reason: 'included_hours_exhausted' },
      'cloud_out_of_hours',
      'out of sandbox hours'
    ]
  ])('maps %o to %s with a next step', async (body, code, text) => {
    fetchMock.mockResolvedValue(Response.json(body, { status: 403 }))
    await main(
      ['worktree', 'create', '--on', 'cloud', '--repo', 'https://github.com/acme/app', '--json'],
      home
    )
    expect(process.exitCode).not.toBeUndefined()
    const payload = JSON.parse(printed())
    expect(payload).toMatchObject({ ok: false, error: { code } })
    expect(payload.error.message).toContain(text)
  })

  it('says how to sign in when there are no credentials', async () => {
    vi.stubEnv('ORCA_CLOUD_TOKEN', '')
    vi.stubEnv('ORCA_CLOUD_API_URL', '')
    await main(
      ['worktree', 'create', '--on', 'cloud', '--repo', 'https://github.com/acme/app', '--json'],
      home
    )
    expect(JSON.parse(printed())).toMatchObject({
      ok: false,
      error: { code: 'cloud_not_signed_in' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses other --on targets in this build, before any request', async () => {
    await main(['worktree', 'create', '--on', 'recipe:dev', '--name', 'x', '--json'], home)
    expect(JSON.parse(printed())).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })
})
