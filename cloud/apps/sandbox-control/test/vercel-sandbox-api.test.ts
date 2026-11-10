import { describe, expect, it } from 'vitest'
import { ProviderError } from '../src/sandbox-provider'
import { createVercelSandboxApi } from '../src/vercel-sandbox-api'

type Seen = { method: string; url: URL; headers: Headers; body: any }

describe('command exit codes', () => {
  it('asks with wait=true and treats a bounded wait that runs out as still running', async () => {
    const seen: URL[] = []
    const client = createVercelSandboxApi({
      token: 'vercel_test_token',
      teamId: 'team_orca',
      projectId: 'prj_orca',
      fetch: (input, init) => {
        seen.push(new URL(String(input)))
        // A running command: the provider holds the wait open until the caller gives up.
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        )
      }
    })
    expect(await client.getCommand('sess_1', 'cmd_1', { wait: true, waitMs: 20 })).toEqual({ exitCode: null })
    expect(seen[0]!.searchParams.get('wait')).toBe('true')
  })

  it('reports the exit code a finished command answers the wait with', async () => {
    const { client, seen } = api(() => Response.json({ command: { id: 'cmd_1', exitCode: 0 } }))
    expect(await client.getCommand('sess_1', 'cmd_1', { wait: true, waitMs: 4000 })).toEqual({ exitCode: 0 })
    expect(seen[0]!.url.searchParams.get('wait')).toBe('true')
  })
})

function api(answer: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const client = createVercelSandboxApi({
    token: 'vercel_test_token',
    teamId: 'team_orca',
    projectId: 'prj_orca',
    fetch: async (input, init) => {
      const entry = {
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      }
      seen.push(entry)
      return answer(entry)
    }
  })
  return { client, seen }
}

const sandboxBody = {
  sandbox: { name: 'orca-prod-sbx_1', status: 'running', currentSessionId: 'sess_1', persistent: true, tags: { orcaSandbox: 'sbx_1' } },
  session: { id: 'sess_1', status: 'running', startedAt: 1000, timeout: 1_800_000, memory: 8192, vcpus: 4 },
  routes: [{ port: 6768, url: 'https://sb-1.vercel.run', subdomain: 'sb-1' }]
}

describe('Vercel Sandbox REST client', () => {
  it('creates a persistent sandbox from the golden snapshot on the v3 endpoint', async () => {
    const { client, seen } = api(() => Response.json(sandboxBody))
    const state = await client.createSandbox({
      name: 'orca-prod-sbx_1',
      snapshotId: 'snap_golden',
      vcpus: 4,
      region: 'iad1',
      timeoutMs: 1_800_000,
      ports: [6768],
      networkPolicy: { allow: { 'registry.npmjs.org': [] } },
      tags: { orcaSandbox: 'sbx_1' },
      snapshotExpirationMs: 104 * 86_400_000
    })
    expect(seen[0]!.method).toBe('POST')
    expect(`${seen[0]!.url.origin}${seen[0]!.url.pathname}${seen[0]!.url.search}`).toBe(
      'https://vercel.com/api/v3/sandboxes?teamId=team_orca'
    )
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer vercel_test_token')
    expect(seen[0]!.body).toMatchObject({
      projectId: 'prj_orca',
      source: { type: 'snapshot', snapshotId: 'snap_golden' },
      resources: { vcpus: 4 },
      persistent: true,
      keepLastSnapshots: { count: 2, expiration: 104 * 86_400_000 },
      snapshotExpiration: 104 * 86_400_000
    })
    expect(state.routes).toEqual([{ port: 6768, url: 'https://sb-1.vercel.run' }])
    expect(state.session.timeoutMs).toBe(1_800_000)
  })

  it('reads the command ndjson stream to the finished exit code', async () => {
    const lines = [
      { command: { id: 'cmd_1', exitCode: null } },
      { stream: 'stdout', data: 'boot\n' },
      { stream: 'stderr', data: 'warn\n' },
      { stream: 'stdout', data: '{"ok":1}\n' },
      { command: { id: 'cmd_1', exitCode: 0 } }
    ]
    const { client, seen } = api(() => new Response(lines.map((l) => JSON.stringify(l)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } }))
    const result = await client.runCommand('sess_1', { command: '/opt/orca/bin/orca-sandbox-start', timeoutMs: 1000 })
    expect(result).toEqual({ exitCode: 0, stdout: 'boot\n{"ok":1}\n', stderr: 'warn\n' })
    expect(seen[0]!.url.pathname).toBe('/api/v2/sandboxes/sessions/sess_1/cmd')
    expect(seen[0]!.body).toMatchObject({ wait: true, logs: true })
  })

  it('treats a missing sandbox as absent and deletes with orphan snapshots', async () => {
    const { client, seen } = api((s) =>
      s.method === 'GET' ? Response.json({ error: { code: 'not_found' } }, { status: 404 }) : Response.json({ error: { code: 'not_found' } }, { status: 404 })
    )
    expect(await client.getSandbox('orca-prod-sbx_9', { resume: true })).toBeNull()
    await client.deleteSandbox('orca-prod-sbx_9')
    expect(seen[0]!.url.searchParams.get('resume')).toBe('true')
    expect(seen[1]!.method).toBe('DELETE')
    expect(seen[1]!.url.searchParams.get('deleteOrphanSnapshots')).toBe('true')
  })

  it('accepts deleting a snapshot Vercel already deleted (400 "expired or deleted")', async () => {
    const { client, seen } = api((s) =>
      s.method === 'DELETE'
        ? Response.json({ error: { code: 'bad_request', message: 'Snapshot expired or deleted.' } }, { status: 400 })
        : Response.json({ snapshot: { id: 'snap_1', status: 'deleted', sourceSessionId: 'sess_1' } })
    )
    await client.deleteSnapshot('snap_1')
    expect(seen.map((s) => s.method)).toEqual(['DELETE', 'GET'])
  })

  it('surfaces provider failures as codes without their bodies', async () => {
    const { client } = api(() => Response.json({ error: { code: 'rate_limited', message: 'secret detail' } }, { status: 429 }))
    const error = await client.stopSession('sess_1').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).message).toBe('provider request failed (429 rate_limited)')
  })
})
