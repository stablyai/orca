import type * as HostCli from './ssh-remote-cli-host-passthrough'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { encodeJsonRpcFrame, HEADER_LENGTH } from './relay-protocol'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'
import { runHostOrcaCliPassthrough } from './ssh-remote-cli-host-passthrough'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { listMcpIssues } from '../linear/mcp-issue-list'
import { IssueListLifetime } from '../linear/mcp-issue-list-lifetime'

const fixture = vi.hoisted(() => ({
  workspace: {
    id: 'account-owner',
    organizationId: 'account-owner',
    organizationName: 'Account owner',
    displayName: 'Fixture',
    email: null,
    credentialRevision: 1
  }
}))
vi.mock('../linear/client', () => ({
  getStatus: () => ({ workspaces: [fixture.workspace], activeWorkspaceId: fixture.workspace.id }),
  getClients: () => [
    {
      workspace: fixture.workspace,
      client: { options: { apiKey: 'synthetic-fixture' } },
      apiKey: 'synthetic-fixture'
    }
  ]
}))
vi.mock('../linear/linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./ssh-remote-cli-host-passthrough', async (original) => ({
  ...(await original<typeof HostCli>()),
  runHostOrcaCliPassthrough: vi.fn()
}))
afterEach(() => vi.unstubAllGlobals())

describe('actual SSH Linear dispatcher and mux delivery', () => {
  it('uses the account-owning runtime for a folder call and holds reservation through mux settlement', async () => {
    let receive!: (data: Buffer) => void
    const written: Buffer[] = []
    const settlements: (() => void)[] = []
    const transport: MultiplexerTransport = {
      supportsWriteSettlement: true,
      onData: (callback) => {
        receive = callback
      },
      onClose: () => {},
      write: (data, settled) => {
        written.push(data)
        settlements.push(() => settled?.({ ok: true }))
      }
    }
    const mux = new SshChannelMultiplexer(transport)
    let size = 130 * 1024
    let bloatOuter = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: {
            issues: {
              nodes: [
                {
                  id: '1',
                  identifier: 'F-1',
                  title: 'Fixture',
                  url: 'https://linear.app/fixture',
                  description: 'x'.repeat(size)
                }
              ],
              pageInfo: { hasNextPage: false }
            }
          }
        })
      )
    )
    const runtime = {
      getRuntimeId: () => 'account-owner-runtime',
      linearMcpIssueList: listMcpIssues,
      linearStatus: () => ({ connected: true, viewer: null, mcpListPageRecoveryVersion: 1 })
    } as unknown as OrcaRuntimeService
    mux.onRequest('orca.cli', async (params, delivery) => {
      const result = await runRemoteOrcaCli(runtime, {
        argv: params.argv as string[],
        cwd: '/remote/folder-without-git',
        env: {},
        delivery
      })
      return bloatOuter ? { ...result, stderr: 'x'.repeat(3 * 1024 * 1024) } : result
    })
    let seq = 0
    const request = async (cursor?: string) => {
      seq++
      receive(
        encodeJsonRpcFrame(
          {
            jsonrpc: '2.0',
            id: seq,
            method: 'orca.cli',
            params: {
              argv: [
                'linear',
                'list-issues',
                '--workspace',
                'account-owner',
                '--limit',
                '1',
                '--json',
                ...(cursor ? ['--cursor', cursor] : [])
              ]
            }
          },
          seq,
          seq - 1
        )
      )
      await vi.waitFor(() => expect(written).toHaveLength(seq))
      const outer = JSON.parse(written[seq - 1].subarray(HEADER_LENGTH).toString())
      expect(Buffer.byteLength(JSON.stringify(outer, null, 2)) + 1).toBeLessThanOrEqual(2_129_920)
      expect(Buffer.byteLength(outer.result.stdout)).toBeLessThanOrEqual(1024 * 1024)
      return JSON.parse(outer.result.stdout)
    }
    const held: IssueListLifetime[] = []
    try {
      const result = await request()
      expect(result._meta.runtimeId).toBe('account-owner-runtime')
      expect(result.result.issues[0].workspace.id).toBe('account-owner')
      expect(result.result.issues[0].description).toHaveLength(130 * 1024)
      for (let i = 0; i < 27; i++) {
        held.push(new IssueListLifetime())
      }
      expect(() => new IssueListLifetime()).toThrow('capacity')
      settlements[0]()
      const recovered = new IssueListLifetime()
      recovered.finish()
      held.splice(0).forEach((owner) => owner.finish())
      size = 950 * 1024
      expect((await request()).error.code).toBe('linear_list_record_too_large')
      settlements[1]()
      size = 1
      expect((await request()).ok).toBe(true)
      settlements[2]()
      bloatOuter = true
      const failure = await request('input-cursor')
      expect(failure.error.code).toBe('linear_list_metadata_capacity')
      expect(failure.error.data.retryPosition.cursor).toBe('input-cursor')
      settlements[3]()
      bloatOuter = false
      expect((await request('input-cursor')).ok).toBe(true)
      settlements[4]()
      expect(runHostOrcaCliPassthrough).not.toHaveBeenCalled()
    } finally {
      held.forEach((owner) => owner.finish())
      mux.dispose()
    }
  })
})
