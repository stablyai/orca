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
const fetchMock = vi.fn()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-cloud-main-'))
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)))
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
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
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://cloud.test/v1/workspaces')
    expect(JSON.parse(String(init.body))).toEqual({ name: 'child' })
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
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://cloud.test/v1/workspaces/sbx_c1/messages')
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello', agent: 'codex' })

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
    expect(body.error.data.nextSteps[0]).toContain('vmCliEnabled')
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
  })
})
