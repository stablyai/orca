import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { HostedSandboxRequest } from '../../hosted-sandbox/hosted-sandbox-request'
import { createCloudMcpEgress } from './cloud-mcp-egress'

type Call = { method: string; path: string; body?: unknown }

function fakeControlPlane(initial: string[]): {
  request: HostedSandboxRequest
  calls: Call[]
  hosts: () => string[]
} {
  let hosts = [...initial]
  const calls: Call[] = []
  const request: HostedSandboxRequest = async (method, path, schema, init) => {
    calls.push({ method, path, ...(init.body === undefined ? {} : { body: init.body }) })
    if (method === 'PUT') {
      hosts = [...z.object({ hosts: z.array(z.string()) }).parse(init.body).hosts]
    }
    return schema.parse({ hosts })
  }
  return { request, calls, hosts: () => hosts }
}

describe('createCloudMcpEgress', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-egress-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const controlPlane = { baseUrl: 'https://cp.example.com', getAccessToken: async () => 't' }

  it('reads first, merges with hosts other tools declared, and remembers only its own', async () => {
    const cp = fakeControlPlane(['tool.example.com'])
    const egress = createCloudMcpEgress({ userDataPath: dir, controlPlane, request: cp.request })

    await egress.apply('sbx_1', ['mcp.a.com'])
    expect(cp.calls.map((c) => c.method)).toEqual(['GET', 'PUT'])
    expect(cp.calls[0]?.path).toBe('v1/sandboxes/sbx_1/egress/hosts')
    expect(cp.hosts()).toEqual(['mcp.a.com', 'tool.example.com'])
    expect(JSON.parse(readFileSync(join(dir, 'cloud-mcp-egress.json'), 'utf8'))).toEqual({
      sbx_1: ['mcp.a.com']
    })

    // Nothing changed: no write.
    cp.calls.length = 0
    await egress.apply('sbx_1', ['mcp.a.com'])
    expect(cp.calls.map((c) => c.method)).toEqual(['GET'])

    // The server went away: its host goes, the other tool's stays.
    await egress.apply('sbx_1', [])
    expect(cp.hosts()).toEqual(['tool.example.com'])
    expect(JSON.parse(readFileSync(join(dir, 'cloud-mcp-egress.json'), 'utf8'))).toEqual({})
  })

  it('makes no calls when there is nothing to open or take back', async () => {
    const cp = fakeControlPlane([])
    const egress = createCloudMcpEgress({ userDataPath: dir, controlPlane, request: cp.request })
    expect(await egress.apply('sbx_2', [])).toEqual({ hosts: [], dropped: [] })
    expect(cp.calls).toEqual([])
  })
})
