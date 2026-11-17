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

vi.mock('../runtime/client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../runtime/launch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  serveOrcaApp: serveOrcaAppMock
}))

vi.mock('../runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

import { main } from '../index'

let home: string
let out: string[]
let err: string[]
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-cloud-main-'))
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)))
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
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

describe('orca cloud via main()', () => {
  it('parses `cloud workspace create --name child --json` and never builds a runtime client', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { workspace: { id: 'sbx_c1', name: 'child', status: 'running', origin: 'vm' } },
        { status: 201 }
      )
    )
    await main(['cloud', 'workspace', 'create', '--name', 'child', '--json'], home)
    expect(process.exitCode).toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://cloud.test/v1/workspaces')
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'child' })
    expect(JSON.parse(out.join(''))).toMatchObject({
      ok: true,
      schemaVersion: 1,
      result: { workspace: { id: 'sbx_c1', origin: 'vm' } }
    })
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('takes the workspace positional for message and sessions', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { message: { id: 'msg_1', workspaceId: 'sbx_c1', status: 'queued', agent: 'codex' } },
        { status: 202 }
      )
    )
    await main(
      ['cloud', 'message', 'sbx_c1', '--text', 'hello', '--agent', 'codex', '--json'],
      home
    )
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://cloud.test/v1/workspaces/sbx_c1/messages')
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'hello', agent: 'codex' })

    fetchMock.mockResolvedValue(Response.json({ workspaceStatus: 'running', sessions: [] }))
    await main(['cloud', 'sessions', 'sbx_c1', '--json'], home)
    expect(fetchMock.mock.calls[1][0]).toBe('https://cloud.test/v1/workspaces/sbx_c1/sessions')
  })

  it('prints a JSON error with code and next steps when in-VM access is off', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'forbidden', reason: 'vm_cli_disabled' }, { status: 403 })
    )
    await main(['cloud', 'workspace', 'list', '--json'], home)
    expect(process.exitCode).toBe(1)
    const body = JSON.parse(out.join(''))
    expect(body).toMatchObject({ ok: false, error: { code: 'cloud_vm_cli_disabled' } })
    expect(body.error.data).toMatchObject({ setting: 'vmCliEnabled' })
    expect(body.error.data.nextSteps[0]).toContain('Ask a team owner or admin')
  })

  it('prints a readable error without --json', async () => {
    vi.stubEnv('ORCA_CLOUD_TOKEN', '')
    await main(['cloud', 'whoami'], home)
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('Not signed in to Orca Cloud.')
    expect(err.join('\n')).toContain('Next step: Run `orca cloud login')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects unknown flags before any request', async () => {
    await main(['cloud', 'workspace', 'create', '--bogus', 'x', '--json'], home)
    expect(process.exitCode).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows help for the cloud group', async () => {
    await main(['cloud', '--help'], home)
    expect(out.join('')).toMatch(/workspace create +Create an Orca Cloud workspace/)
    expect(out.join('')).toMatch(
      /workspace delete +Delete an Orca Cloud workspace and its sandbox for good/
    )
    expect(out.join('')).toMatch(/routine run +Run an Orca Cloud routine now/)
    // `destroy` still works but is hidden from help.
    expect(out.join('')).not.toContain('workspace destroy')
  })

  it('deletes with `workspace delete` and the hidden `destroy` alias', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ workspace: { id: 'sbx_d1', name: 'old', status: 'destroyed' } })
    )
    await main(['cloud', 'workspace', 'delete', 'sbx_d1'], home)
    expect(process.exitCode).toBeUndefined()
    expect(out.join('\n')).toContain(
      'Deleted old (sbx_d1). Its sandbox and files are gone for good.'
    )
    await main(['cloud', 'workspace', 'destroy', 'sbx_d1', '--json'], home)
    expect(process.exitCode).toBeUndefined()
    expect(
      fetchMock.mock.calls.map(([url, init]) => `${String(init?.method)} ${String(url)}`)
    ).toEqual([
      'DELETE https://cloud.test/v1/workspaces/sbx_d1',
      'DELETE https://cloud.test/v1/workspaces/sbx_d1'
    ])
  })

  it('rejects --size on workspace create before any request', async () => {
    await main(['cloud', 'workspace', 'create', '--size', 'large', '--json'], home)
    expect(process.exitCode).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lists workspaces with glossary states and keeps raw statuses for --json', async () => {
    const listed = {
      workspaces: [
        {
          id: 'sbx_l1',
          name: 'api',
          status: 'sleeping',
          archived: true,
          repoUrl: 'https://github.com/acme/api.git',
          repoBranch: 'main',
          lastActivityAt: Date.now() - 120_000,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    fetchMock.mockImplementation(async () => Response.json(listed))
    await main(['cloud', 'workspace', 'list'], home)
    const text = out.join('\n')
    expect(text).toMatch(/^ID +NAME +STATE +REPO +BRANCH +LAST ACTIVE$/m)
    expect(text).toMatch(/sbx_l1 +api +Archived +acme\/api +main +2m ago/)
    expect(text).not.toContain('sleeping')
    out = []
    await main(['cloud', 'workspace', 'list', '--json'], home)
    expect(JSON.parse(out.join(''))).toMatchObject({
      result: { workspaces: [{ status: 'sleeping', archived: true }] }
    })
  })

  it('prints glossary error copy for admin-only, rate-limited and out-of-hours errors', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: 'forbidden', reason: 'admin_required' }, { status: 403 })
    )
    await main(['cloud', 'workspace', 'list'], home)
    expect(err.join('\n')).toContain('Only a team owner or admin can do this.')
    err = []
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '7' } })
    )
    await main(['cloud', 'workspace', 'list'], home)
    expect(err.join('\n')).toContain('Try again in 7 seconds.')
    err = []
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: 'entitlement_denied', reason: 'included_hours_exhausted' },
        { status: 403 }
      )
    )
    await main(['cloud', 'workspace', 'create', '--name', 'x'], home)
    expect(err.join('\n')).toContain(
      "Your team is out of sandbox hours. Running sandboxes go to sleep and new ones can't start. Nothing was created, and you weren't charged."
    )
    expect(err.join('\n')).toContain('Ask an owner or admin to add hours.')
    expect(err.join('\n')).not.toMatch(/entitlement_denied|included_hours_exhausted|files are safe/)
  })

  it('runs a routine by name and follows it with --wait', async () => {
    const routine = {
      id: 'rtn_r1',
      name: 'Triage',
      enabled: true,
      trigger: { kind: 'webhook' },
      maxRuntimeMinutes: 30
    }
    const statuses = ['running', 'posting', 'succeeded']
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/routines')) {
        return Response.json({ routines: [routine] })
      }
      if (url.endsWith('/v1/routines/rtn_r1/run') && init?.method === 'POST') {
        return Response.json(
          { run: { id: 'run_1', status: 'queued', result: null, durationMs: null } },
          { status: 202 }
        )
      }
      const status = statuses.shift() ?? 'succeeded'
      return Response.json({
        run: {
          id: 'run_1',
          status,
          durationMs: status === 'succeeded' ? 102_000 : null,
          result: status === 'succeeded' ? { prUrl: 'https://github.com/acme/api/pull/7' } : null
        }
      })
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const done = main(['cloud', 'routine', 'run', 'Triage', '--wait'], home)
      await vi.runAllTimersAsync()
      await done
    } finally {
      vi.useRealTimers()
    }
    expect(process.exitCode).toBeUndefined()
    expect(err).toEqual([
      '- Triage: Queued',
      '- Triage: Running',
      '- Triage: Posting results',
      '- Triage: Succeeded'
    ])
    expect(out.join('\n')).toContain('Triage: Succeeded (run_1)')
    expect(out.join('\n')).toContain('Took 1m 42s')
    expect(out.join('\n')).toContain('Pull request: https://github.com/acme/api/pull/7')
  })
})
