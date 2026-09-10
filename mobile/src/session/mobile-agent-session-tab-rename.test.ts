import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSessionTab } from './mobile-session-route-types'
import { renameAgentSessionTab } from './mobile-agent-session-tab-rename'

const WORKTREE_ID = 'repo-1::/tmp/app'
const CHAT: Extract<MobileSessionTab, { type: 'agent-session' }> = {
  type: 'agent-session',
  id: 'agent-session:codex-1',
  title: 'Codex Chat',
  sessionId: 'codex-1',
  agent: 'codex',
  isActive: true
}

function makeClient(response: unknown): {
  client: RpcClient
  sendRequest: ReturnType<typeof vi.fn>
} {
  const sendRequest = vi.fn(async () => response)
  return { client: { sendRequest } as unknown as RpcClient, sendRequest }
}

describe('renameAgentSessionTab', () => {
  it('asks the host that owns the chat to name it', async () => {
    const { client, sendRequest } = makeClient({ id: '1', ok: true, result: { updated: true } })

    const outcome = await renameAgentSessionTab({
      client,
      worktreeId: WORKTREE_ID,
      target: CHAT,
      value: '  Release notes  ',
      tabs: [CHAT]
    })

    expect(sendRequest).toHaveBeenCalledWith('session.tabs.setTabProps', {
      worktree: `id:${WORKTREE_ID}`,
      tabId: 'agent-session:codex-1',
      title: 'Release notes'
    })
    expect(outcome).toEqual({
      kind: 'renamed',
      tabs: [{ ...CHAT, title: 'Release notes' }]
    })
  })

  it('clears the name rather than publishing an empty one', async () => {
    const { client, sendRequest } = makeClient({ id: '1', ok: true, result: { updated: true } })

    const outcome = await renameAgentSessionTab({
      client,
      worktreeId: WORKTREE_ID,
      target: CHAT,
      value: '   ',
      tabs: [CHAT]
    })

    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ title: null })
    // The host resolves the placeholder; the sheet must not blank the label in the meantime.
    expect(outcome.kind === 'renamed' && outcome.tabs[0]?.title).toBe('Codex Chat')
  })

  it('reports a host too old to name a chat separately from a refused rename', async () => {
    const tooOld = await renameAgentSessionTab({
      client: makeClient({
        id: '1',
        ok: false,
        error: { code: 'forbidden', message: "Method 'x' is not available to mobile clients" }
      }).client,
      worktreeId: WORKTREE_ID,
      target: CHAT,
      value: 'Release notes',
      tabs: [CHAT]
    })
    expect(tooOld).toEqual({ kind: 'unsupported' })

    const refused = await renameAgentSessionTab({
      client: makeClient({
        id: '1',
        ok: false,
        error: { code: 'invalid_params', message: 'Missing tab id' }
      }).client,
      worktreeId: WORKTREE_ID,
      target: CHAT,
      value: 'Release notes',
      tabs: [CHAT]
    })
    expect(refused).toEqual({ kind: 'failed' })
  })

  it('reports a transport failure without dropping the tab list', async () => {
    const client = {
      sendRequest: vi.fn(async () => {
        throw new Error('socket closed')
      })
    } as unknown as RpcClient

    await expect(
      renameAgentSessionTab({
        client,
        worktreeId: WORKTREE_ID,
        target: CHAT,
        value: 'Release notes',
        tabs: [CHAT]
      })
    ).resolves.toEqual({ kind: 'failed' })
  })
})
