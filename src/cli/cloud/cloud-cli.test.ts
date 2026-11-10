import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { cloudApiError } from './cloud-api-client'
import {
  cloudCredentialsPath,
  nodeCloudCredentialFs,
  resolveCloudCredentials,
  writeCloudCredentials
} from './cloud-credentials'
import { createCloudHandlers, type CloudHandlerDeps } from './cloud-handlers'
import { normalizeCloudRepoUrl } from './cloud-operations'
import type { CloudWorkspace } from './cloud-format'

const API = 'https://cloud.test'

function workspace(overrides: Partial<CloudWorkspace> = {}): CloudWorkspace {
  return {
    id: 'sbx_aa11',
    name: 'child',
    projectId: null,
    status: 'running',
    archived: false,
    hidden: false,
    origin: 'vm',
    machineSize: 'standard',
    region: 'iad1',
    repoUrl: null,
    session: null,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  }
}

type Call = { method: string; url: string; body: unknown; auth: string | null }

/** A fake control plane: routes are "METHOD /path" → handler returning [status, body]. */
function fakeApi(
  routes: Record<
    string,
    (call: Call) => [number, unknown] | [number, unknown, Record<string, string>]
  >
) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input)
    const call: Call = {
      method: init.method ?? 'GET',
      url: `${url.pathname}${url.search}`,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get('authorization')
    }
    calls.push(call)
    const route = routes[`${call.method} ${url.pathname}`]
    if (!route) {
      return Response.json({ error: 'not_found' }, { status: 404 })
    }
    const [status, body, headers] = route(call)
    return Response.json(body, { status, headers })
  })
  return { calls, fetchImpl }
}

let home: string
let logs: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-cloud-cli-'))
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

function writeFile(contents: unknown): string {
  const path = join(home, '.config', 'orca-cloud', 'credentials.json')
  mkdirSync(join(home, '.config', 'orca-cloud'), { recursive: true })
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return path
}

function deps(
  fetchImpl: CloudHandlerDeps['fetch'],
  env: Record<string, string | undefined> = {
    ORCA_CLOUD_TOKEN: 'orca_sk_test',
    ORCA_CLOUD_API_URL: API
  },
  extra: Partial<CloudHandlerDeps> = {}
): CloudHandlerDeps {
  let clock = 10_000
  return {
    env,
    fetch: fetchImpl,
    fs: nodeCloudCredentialFs,
    home,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    readStdin: async () => null,
    ...extra
  }
}

function ctx(flags: Record<string, string | boolean>, json = true): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    // These handlers must never reach the Orca runtime.
    get client(): never {
      throw new Error('cloud commands must not use the runtime client')
    },
    cwd: home,
    json
  }
}

function lastJson(): { ok: boolean; schemaVersion: number; result: Record<string, unknown> } {
  return JSON.parse(logs.at(-1)!)
}

describe('cloud credential resolution', () => {
  it('prefers ORCA_CLOUD_TOKEN + ORCA_CLOUD_API_URL over the credentials file', () => {
    writeFile({ apiUrl: 'https://file.test', token: 'orca_ws_file', workspaceId: 'sbx_file' })
    const creds = resolveCloudCredentials(
      { ORCA_CLOUD_TOKEN: 'orca_sk_env', ORCA_CLOUD_API_URL: 'https://env.test/' },
      { home }
    )
    expect(creds).toEqual({
      apiUrl: 'https://env.test',
      token: 'orca_sk_env',
      workspaceId: null,
      source: 'env',
      path: null
    })
  })

  it('takes the URL from the file when only ORCA_CLOUD_TOKEN is set', () => {
    writeFile({ apiUrl: 'https://file.test', token: 'orca_ws_file' })
    expect(resolveCloudCredentials({ ORCA_CLOUD_TOKEN: 'orca_sk_env' }, { home }).apiUrl).toBe(
      'https://file.test'
    )
  })

  it('reads the file the control plane writes inside a VM', () => {
    const path = writeFile({
      apiUrl: 'https://cp.test',
      token: 'orca_ws_abc',
      workspaceId: 'sbx_1'
    })
    expect(resolveCloudCredentials({}, { home })).toEqual({
      apiUrl: 'https://cp.test',
      token: 'orca_ws_abc',
      workspaceId: 'sbx_1',
      source: 'file',
      path
    })
  })

  it('honours ORCA_CLOUD_CREDENTIALS_FILE', () => {
    const custom = join(home, 'custom.json')
    writeFileSync(custom, JSON.stringify({ apiUrl: API, token: 't' }))
    expect(cloudCredentialsPath({ ORCA_CLOUD_CREDENTIALS_FILE: custom }, home)).toBe(custom)
    expect(resolveCloudCredentials({ ORCA_CLOUD_CREDENTIALS_FILE: custom }, { home }).token).toBe(
      't'
    )
  })

  it('explains how to sign in when nothing is configured, including the in-VM setting', () => {
    expect(() => resolveCloudCredentials({}, { home })).toThrow(
      expect.objectContaining({
        code: 'cloud_not_signed_in',
        data: expect.objectContaining({
          nextSteps: [
            expect.stringContaining('orca cloud login'),
            expect.stringContaining('vmCliEnabled')
          ]
        })
      })
    )
  })

  it('refuses ORCA_CLOUD_TOKEN without any URL', () => {
    expect(() => resolveCloudCredentials({ ORCA_CLOUD_TOKEN: 'x' }, { home })).toThrow(
      expect.objectContaining({
        code: 'cloud_not_signed_in',
        message: expect.stringContaining('ORCA_CLOUD_API_URL')
      })
    )
  })

  it('rejects malformed files and non-https URLs', () => {
    writeFile('{not json')
    expect(() => resolveCloudCredentials({}, { home })).toThrow(
      expect.objectContaining({ code: 'cloud_credentials_invalid' })
    )
    expect(() =>
      resolveCloudCredentials(
        { ORCA_CLOUD_TOKEN: 'x', ORCA_CLOUD_API_URL: 'http://evil.test' },
        { home }
      )
    ).toThrow(/https/)
    expect(
      resolveCloudCredentials(
        { ORCA_CLOUD_TOKEN: 'x', ORCA_CLOUD_API_URL: 'http://localhost:8787' },
        { home }
      ).apiUrl
    ).toBe('http://localhost:8787')
  })

  it.skipIf(process.platform === 'win32')('writes the credentials file 0600', () => {
    const path = writeCloudCredentials({}, { apiUrl: API, token: 'orca_sk_x' }, { home })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ apiUrl: API, token: 'orca_sk_x' })
  })
})

describe('cloud API error messages', () => {
  const user = { source: 'file' as const, token: 'orca_sk_x', path: '/p' }
  const vm = { source: 'file' as const, token: 'orca_ws_x', path: '/p' }

  it('names the org setting when in-VM access is off', () => {
    const error = cloudApiError(
      403,
      { error: 'forbidden', reason: 'vm_cli_disabled' },
      { credentials: vm }
    )
    expect(error.code).toBe('cloud_vm_cli_disabled')
    expect(error.message).toContain('turned off')
    expect(JSON.stringify(error.data)).toContain('vmCliEnabled')
  })

  it('explains token expiry differently for workspace tokens and keys', () => {
    expect(cloudApiError(401, { error: 'unauthorized' }, { credentials: vm }).message).toContain(
      'turned off for the organization'
    )
    expect(cloudApiError(401, { error: 'unauthorized' }, { credentials: user }).data).toMatchObject(
      {
        nextSteps: [expect.stringContaining('orca cloud login')]
      }
    )
  })

  it('explains own-workspace refusals, sibling-only visibility, scopes and rate limits', () => {
    expect(
      cloudApiError(403, { error: 'forbidden', reason: 'own_workspace' }, { credentials: vm })
        .message
    ).toContain('cannot sleep, archive or destroy itself')
    expect(cloudApiError(404, { error: 'not_found' }, { credentials: vm }).message).toContain(
      'workspaces it created'
    )
    expect(
      cloudApiError(
        403,
        { error: 'insufficient_scope', reason: 'workspaces:write' },
        { credentials: user }
      ).message
    ).toContain('workspaces:write')
    expect(
      cloudApiError(429, { error: 'rate_limited' }, { credentials: user, retryAfter: '12' }).data
    ).toMatchObject({ retryAfterSeconds: 12, nextSteps: ['Retry in 12s.'] })
  })
})

describe('orca cloud handlers', () => {
  it('workspace create posts the body and prints { ok, schemaVersion, result }', async () => {
    const api = fakeApi({
      'POST /v1/workspaces': () => [201, { workspace: workspace() }]
    })
    await createCloudHandlers(() => deps(api.fetchImpl))['cloud workspace create'](
      ctx({ name: 'child', repo: 'git@github.com:acme/app.git', ref: 'main', size: 'large' })
    )
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      url: '/v1/workspaces',
      auth: 'Bearer orca_sk_test',
      body: {
        name: 'child',
        repo: { url: 'https://github.com/acme/app.git', ref: 'main' },
        machineSize: 'large'
      }
    })
    const out = lastJson()
    expect(out).toMatchObject({
      ok: true,
      schemaVersion: 1,
      result: { workspace: { id: 'sbx_aa11', origin: 'vm' } }
    })
    expect(typeof out.result.elapsedMs).toBe('number')
  })

  it('workspace create turns --agent/--prompt into the first message and resolves --project by name', async () => {
    const api = fakeApi({
      'GET /v1/projects': () => [200, { projects: [{ id: 'prj_1', name: 'web' }] }],
      'POST /v1/workspaces': () => [
        201,
        { workspace: workspace(), message: { id: 'msg_1', status: 'queued' } }
      ]
    })
    await createCloudHandlers(() => deps(api.fetchImpl))['cloud workspace create'](
      ctx({ project: 'web', agent: 'codex', prompt: 'hi' })
    )
    expect(api.calls.at(-1)!.body).toEqual({
      projectId: 'prj_1',
      message: { text: 'hi', agent: 'codex' }
    })
  })

  it('rejects bad flags before calling the API', async () => {
    const api = fakeApi({})
    const handlers = createCloudHandlers(() => deps(api.fetchImpl))
    await expect(
      handlers['cloud workspace create'](ctx({ agent: 'claude' }))
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('--prompt')
    })
    await expect(
      handlers['cloud workspace create'](ctx({ agent: 'gpt', prompt: 'x' }))
    ).rejects.toThrow('--agent must be one of: claude, codex')
    await expect(handlers['cloud workspace create'](ctx({ size: 'huge' }))).rejects.toThrow(
      '--size'
    )
    await expect(
      handlers['cloud workspace create'](ctx({ repo: 'http://x.test/a' }))
    ).rejects.toThrow('https')
    await expect(
      handlers['cloud message'](ctx({ workspace: 'sbx_1', text: 'x', session: 'bogus' }))
    ).rejects.toThrow('--session')
    expect(api.calls).toHaveLength(0)
  })

  it('resolves a workspace by name and maps lifecycle verbs to routes', async () => {
    const api = fakeApi({
      'GET /v1/workspaces': () => [
        200,
        { workspaces: [workspace({ id: 'sbx_b2', name: 'child' })] }
      ],
      'POST /v1/workspaces/sbx_b2/sleep': () => [
        200,
        { workspace: workspace({ id: 'sbx_b2', status: 'sleeping' }) }
      ],
      'DELETE /v1/workspaces/sbx_b2': () => [
        200,
        { workspace: workspace({ id: 'sbx_b2', status: 'destroyed' }) }
      ]
    })
    const handlers = createCloudHandlers(() => deps(api.fetchImpl))
    await handlers['cloud workspace sleep'](ctx({ workspace: 'child' }))
    await handlers['cloud workspace destroy'](ctx({ workspace: 'sbx_b2' }))
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/workspaces?include=archived',
      'POST /v1/workspaces/sbx_b2/sleep',
      'DELETE /v1/workspaces/sbx_b2'
    ])
    expect(lastJson().result).toMatchObject({ workspace: { status: 'destroyed' } })
  })

  it('reports ambiguous and missing names, and `self` from VM credentials', async () => {
    const api = fakeApi({
      'GET /v1/workspaces': () => [
        200,
        { workspaces: [workspace({ id: 'sbx_1' }), workspace({ id: 'sbx_2' })] }
      ],
      'GET /v1/workspaces/sbx_self': () => [200, { workspace: workspace({ id: 'sbx_self' }) }]
    })
    const handlers = createCloudHandlers(() => deps(api.fetchImpl))
    await expect(
      handlers['cloud workspace show'](ctx({ workspace: 'child' }))
    ).rejects.toMatchObject({
      code: 'selector_ambiguous'
    })
    await expect(
      handlers['cloud workspace show'](ctx({ workspace: 'nope' }))
    ).rejects.toMatchObject({
      code: 'cloud_not_found'
    })
    await expect(handlers['cloud workspace show'](ctx({ workspace: 'self' }))).rejects.toThrow(
      'inside an Orca Cloud workspace'
    )

    writeFile({ apiUrl: API, token: 'orca_ws_t', workspaceId: 'sbx_self' })
    await createCloudHandlers(() => deps(api.fetchImpl, {}))['cloud workspace show'](
      ctx({ workspace: 'self' })
    )
    expect(api.calls.at(-1)).toMatchObject({
      url: '/v1/workspaces/sbx_self',
      auth: 'Bearer orca_ws_t'
    })
  })

  it('message --wait polls until delivered and returns the session handle', async () => {
    let polls = 0
    const api = fakeApi({
      'POST /v1/workspaces/sbx_1/messages': () => [
        202,
        {
          message: {
            id: 'msg_1',
            workspaceId: 'sbx_1',
            agent: 'claude',
            status: 'queued',
            session: null
          }
        }
      ],
      'GET /v1/workspaces/sbx_1/messages/msg_1': () => {
        polls += 1
        return [
          200,
          {
            message: {
              id: 'msg_1',
              workspaceId: 'sbx_1',
              agent: 'claude',
              status: polls < 3 ? 'delivering' : 'delivered',
              session: polls < 3 ? null : 'term_abc'
            }
          }
        ]
      }
    })
    await createCloudHandlers(() => deps(api.fetchImpl))['cloud message'](
      ctx({ workspace: 'sbx_1', text: 'run tests', wait: true })
    )
    expect(api.calls[0].body).toEqual({ text: 'run tests' })
    expect(polls).toBe(3)
    expect(lastJson().result).toMatchObject({
      message: { status: 'delivered', session: 'term_abc' },
      waitedMs: 4500
    })
  })

  it('message --wait fails with the delivery error, and times out with a follow-up command', async () => {
    const failed = fakeApi({
      'POST /v1/workspaces/sbx_1/messages': () => [
        202,
        {
          message: {
            id: 'msg_1',
            workspaceId: 'sbx_1',
            status: 'failed',
            error: 'agent_launch_failed'
          }
        }
      ]
    })
    await expect(
      createCloudHandlers(() => deps(failed.fetchImpl))['cloud message'](
        ctx({ workspace: 'sbx_1', text: 'x', wait: true })
      )
    ).rejects.toMatchObject({
      code: 'cloud_message_failed',
      message: expect.stringContaining('agent_launch_failed')
    })

    const stuck = fakeApi({
      'POST /v1/workspaces/sbx_1/messages': () => [
        202,
        { message: { id: 'msg_1', workspaceId: 'sbx_1', status: 'queued' } }
      ],
      'GET /v1/workspaces/sbx_1/messages/msg_1': () => [
        200,
        { message: { id: 'msg_1', workspaceId: 'sbx_1', status: 'queued' } }
      ]
    })
    await expect(
      createCloudHandlers(() => deps(stuck.fetchImpl))['cloud message'](
        ctx({ workspace: 'sbx_1', text: 'x', wait: true, timeout: '3' })
      )
    ).rejects.toMatchObject({
      code: 'cloud_message_timeout',
      data: expect.objectContaining({
        nextSteps: ['Check later: orca cloud messages sbx_1 msg_1']
      })
    })
  })

  it('surfaces vm_cli_disabled from the API as a clear error', async () => {
    writeFile({ apiUrl: API, token: 'orca_ws_t', workspaceId: 'sbx_a' })
    const api = fakeApi({
      'POST /v1/workspaces': () => [403, { error: 'forbidden', reason: 'vm_cli_disabled' }]
    })
    await expect(
      createCloudHandlers(() => deps(api.fetchImpl, {}))['cloud workspace create'](
        ctx({ name: 'child' })
      )
    ).rejects.toMatchObject({ code: 'cloud_vm_cli_disabled' })
  })

  it('login verifies the token, then saves it; logout removes it', async () => {
    const api = fakeApi({
      'GET /v1/me': (call) =>
        call.auth === 'Bearer orca_sk_good'
          ? [
              200,
              {
                accountId: 'org:acme',
                userId: 'u1',
                orgId: 'acme',
                role: 'owner',
                via: 'user',
                scopes: []
              }
            ]
          : [401, { error: 'unauthorized' }]
    })
    const handlers = createCloudHandlers(() =>
      deps(api.fetchImpl, {}, { readStdin: async () => 'orca_sk_good\n' })
    )
    await expect(
      handlers['cloud login'](ctx({ token: 'orca_sk_bad', 'api-url': API }))
    ).rejects.toMatchObject({ code: 'cloud_unauthorized' })
    expect(() => resolveCloudCredentials({}, { home })).toThrow()

    await handlers['cloud login'](ctx({ 'api-url': API }))
    expect(resolveCloudCredentials({}, { home })).toMatchObject({
      apiUrl: API,
      token: 'orca_sk_good'
    })
    expect(lastJson().result).toMatchObject({ tokenKind: 'API key' })

    await handlers['cloud logout'](ctx({}))
    expect(lastJson().result).toMatchObject({ removed: true })
  })

  it('whoami reports the credential source and token kind', async () => {
    const api = fakeApi({
      'GET /v1/me': () => [
        200,
        {
          accountId: 'org:acme',
          userId: 'u1',
          orgId: 'acme',
          role: 'member',
          via: 'workspace',
          scopes: ['workspaces:read'],
          workspaceId: 'sbx_a'
        }
      ]
    })
    writeFile({ apiUrl: API, token: 'orca_ws_t', workspaceId: 'sbx_a' })
    await createCloudHandlers(() => deps(api.fetchImpl, {}))['cloud whoami'](ctx({}, false))
    expect(logs.at(-1)).toContain('via: workspace (workspace token from')
    expect(logs.at(-1)).toContain('workspace: sbx_a')
  })

  it('wraps network failures as cloud_unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(
      createCloudHandlers(() => deps(fetchImpl))['cloud projects list'](ctx({}))
    ).rejects.toMatchObject({ code: 'cloud_unreachable' })
  })
})

describe('normalizeCloudRepoUrl', () => {
  it('rewrites ssh remotes and drops embedded credentials', () => {
    expect(normalizeCloudRepoUrl('git@github.com:acme/app.git')).toBe(
      'https://github.com/acme/app.git'
    )
    expect(normalizeCloudRepoUrl('ssh://git@github.com/acme/app')).toBe(
      'https://github.com/acme/app'
    )
    expect(normalizeCloudRepoUrl('https://user:pw@github.com/acme/app')).toBe(
      'https://github.com/acme/app'
    )
  })
})
