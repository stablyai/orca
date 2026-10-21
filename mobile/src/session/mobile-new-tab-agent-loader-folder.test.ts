import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../src/shared/protocol-version'
import {
  loadMobileNewTabAgentOptions,
  MobileAgentDetectionNeedsHostUpdateError,
  MobileWorkspaceOnOtherRuntimeError
} from './mobile-new-tab-agent-loader'

type Reply = { ok: boolean; result?: unknown; error?: { code: string; message: string } }

type HostFixture = {
  repos?: unknown
  groups?: unknown
  folderWorkspaces?: unknown
  refused?: string
  hostPlatform?: string
  detectAgents?: (params: unknown) => Reply
}

const REFUSED: Reply = { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }

function createHost(fixture: HostFixture): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  const lists: Record<string, Reply> = {
    'repo.list': { ok: true, result: { repos: fixture.repos ?? [{ id: 'repo-1' }] } },
    'projectGroup.list': { ok: true, result: { groups: fixture.groups ?? [{ id: 'pg-1' }] } },
    'folderWorkspace.list': {
      ok: true,
      result: {
        folderWorkspaces: fixture.folderWorkspaces ?? [{ id: 'fw-1', projectGroupId: 'pg-1' }]
      }
    },
    'status.get': { ok: true, result: { hostPlatform: fixture.hostPlatform ?? 'darwin' } },
    'settings.get': { ok: true, result: { settings: {} } }
  }
  const handler = async (method: string, params?: unknown): Promise<Reply> => {
    if (method === fixture.refused) {
      return REFUSED
    }
    if (method === 'preflight.detectAgents' && fixture.detectAgents) {
      return fixture.detectAgents(params)
    }
    const reply = lists[method]
    if (!reply) {
      throw new Error(`unexpected request: ${method}`)
    }
    return reply
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test double implements the two members the loader calls.
  return {
    sendRequest: vi.fn(handler),
    subscribe: vi.fn(() => () => {})
  } as unknown as RpcClient & {
    sendRequest: ReturnType<typeof vi.fn>
  }
}

const CURRENT_HOST = { hostRefusesOtherRuntime: true, hostScopesDetection: true }
const claude = (): Reply => ({ ok: true, result: ['claude'] })

function sentMethods(client: { sendRequest: ReturnType<typeof vi.fn> }): string[] {
  return client.sendRequest.mock.calls.map(([method]) => String(method))
}

describe('mobile new-tab agents for a folder workspace', () => {
  it('#16215: lets a current host resolve the folder from its id, without listing anything', async () => {
    const client = createHost({
      detectAgents: (params) => {
        expect(params).toEqual({ worktreeId: 'folder:fw-1' })
        return claude()
      }
    })
    await expect(
      loadMobileNewTabAgentOptions({ client, worktreeId: 'folder:fw-1', ...CURRENT_HOST })
    ).resolves.toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(sentMethods(client)).toEqual(['preflight.detectAgents', 'settings.get'])
  })

  it("reads a current host's refusal for a folder another runtime owns", async () => {
    const client = createHost({
      detectAgents: () => ({
        ok: false,
        error: { code: 'runtime_error', message: WORKSPACE_ON_OTHER_RUNTIME }
      })
    })
    await expect(
      loadMobileNewTabAgentOptions({ client, worktreeId: 'folder:fw-1', ...CURRENT_HOST })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
  })

  it('does not trust a host that scopes detection but cannot refuse another runtime', async () => {
    const client = createHost({
      folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'pg-1', executionHostId: 'runtime:env-b' }]
    })
    await expect(
      loadMobileNewTabAgentOptions({ client, worktreeId: 'folder:fw-1', hostScopesDetection: true })
    ).rejects.toBeInstanceOf(MobileAgentDetectionNeedsHostUpdateError)
    expect(sentMethods(client)).not.toContain('preflight.detectAgents')
  })

  describe('on an older host, which discards the id and answers for its own PATH', () => {
    it.each(['darwin', 'linux'])(
      "lists a %s host's agents when nothing it holds runs elsewhere",
      async (hostPlatform) => {
        const client = createHost({
          hostPlatform,
          repos: [
            { id: 'repo-1', executionHostId: 'local' },
            { id: 'repo-2', connectionId: null }
          ],
          groups: [{ id: 'pg-1', connectionId: '' }],
          detectAgents: (params) => {
            expect(params).toBeUndefined()
            return claude()
          }
        })
        await expect(
          loadMobileNewTabAgentOptions({ client, worktreeId: 'folder:fw-1' })
        ).resolves.toEqual([{ agent: 'claude', label: 'Claude' }])
      }
    )

    it.each([
      ['the folder runs over SSH', { folderWorkspaces: [{ id: 'fw-1', connectionId: 'box' }] }],
      ['its project group runs over SSH', { groups: [{ id: 'pg-1', connectionId: 'box' }] }],
      [
        'an unrelated repo runs over SSH',
        { repos: [{ id: 'repo-1' }, { id: 'r2', connectionId: 'box' }] }
      ],
      ['a repo is pinned to SSH', { repos: [{ id: 'repo-1', executionHostId: 'ssh:box' }] }],
      [
        'the folder is on another runtime',
        { folderWorkspaces: [{ id: 'fw-1', executionHostId: 'runtime:env-b' }] }
      ],
      ['a placement value is malformed', { groups: [{ id: 'pg-1', connectionId: 42 }] }],
      ['a repo with no id runs over SSH', { repos: [{ id: 'repo-1' }, { connectionId: 'box' }] }],
      [
        'a folder with no id is on another runtime',
        { folderWorkspaces: [{ id: 'fw-1' }, { executionHostId: 'runtime:env-b' }] }
      ],
      ['a list holds a row that is not an object', { groups: [{ id: 'pg-1' }, 'pg-2'] }],
      ['the repo list is not a list', { repos: 'repo-1' }],
      ['the host is Windows, where a folder may run in WSL', { hostPlatform: 'win32' }],
      ['the host reports no platform it can name', { hostPlatform: 'plan9' }],
      ['the host does not list the folder', { folderWorkspaces: [{ id: 'fw-2' }] }],
      ['the host refuses the folder list', { refused: 'folderWorkspace.list' }],
      ['the host refuses the repo list', { refused: 'repo.list' }],
      ['the host refuses its status', { refused: 'status.get' }]
    ])('asks for a desktop update instead of guessing when %s', async (_case, fixture) => {
      const client = createHost(fixture)
      await expect(
        loadMobileNewTabAgentOptions({ client, worktreeId: 'folder:fw-1' })
      ).rejects.toBeInstanceOf(MobileAgentDetectionNeedsHostUpdateError)
      expect(sentMethods(client)).not.toContain('preflight.detectAgents')
      expect(sentMethods(client)).not.toContain('preflight.detectRemoteAgents')
    })
  })
})
