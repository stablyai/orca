// A chat's cwd outside every workspace targets the chat's own workspace when Orca locates it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_SOURCE_ID_ENV } from '../../shared/remote-runtime/host-catalog/runtime-source-env'
import type { OrchestrationPartyLocationResult } from '../../shared/orchestration/orchestration-caller-status'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'
import { getBrowserWorktreeSelector } from './workspace-selector'

const SESSION_ID = '3f2c9a1e-7b44-4d0a-9c1e-5a6b7c8d9e0f'
const ADDRESS = `orca_session_id:${SESSION_ID}`
const root = mkdtempSync(join(tmpdir(), 'orca-chat-caller-'))
const outside = mkdtempSync(join(tmpdir(), 'orca-chat-outside-'))
const worktreeA = { id: 'repo::a', repoId: 'repo', path: join(root, 'a') }
const worktreeB = { id: 'repo::b', repoId: 'repo', path: join(root, 'b') }

function chatAt(worktreeId: string): OrchestrationPartyLocationResult {
  return { location: { kind: 'chat', sessionId: SESSION_ID, worktreeId } }
}

function callerClient(location: OrchestrationPartyLocationResult | RuntimeClientError) {
  const client = new RuntimeClient(join(root, 'user-data'), 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'worktree.list') {
      return okFixture('list', { worktrees: [worktreeA, worktreeB] })
    }
    if (method === 'folderWorkspace.list') {
      return okFixture('folders', { folderWorkspaces: [] })
    }
    if (method === 'orchestration.partyLocation') {
      if (location instanceof RuntimeClientError) {
        throw location
      }
      const named = JSON.stringify(params) === JSON.stringify({ address: ADDRESS })
      return okFixture('party', named ? location : { location: null, lost: 'chat' })
    }
    throw new Error(`unexpected method ${method}`)
  })
  return client
}

// Clear an Orca terminal's own launch env so only the chat's session id names the caller.
beforeEach(() => {
  vi.stubEnv(RUNTIME_SOURCE_ID_ENV, '')
  vi.stubEnv('ORCA_WORKTREE_ID', '')
  vi.stubEnv('ORCA_WORKSPACE_ID', '')
  vi.stubEnv('ORCA_AGENT_SESSION_ID', SESSION_ID)
})
afterEach(() => vi.unstubAllEnvs())
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('getBrowserWorktreeSelector from a chat outside every workspace', () => {
  it("targets the chat's own workspace", async () => {
    await expect(
      getBrowserWorktreeSelector(new Map(), outside, callerClient(chatAt(worktreeA.id)))
    ).resolves.toBe('id:repo::a')
  })

  it("targets a folder chat's own folder workspace", async () => {
    await expect(
      getBrowserWorktreeSelector(new Map(), outside, callerClient(chatAt('folder:notes')))
    ).resolves.toBe('folder:notes')
  })

  it('keeps the focused-workspace default on an Orca too old to locate the chat', async () => {
    const tooOld = new RuntimeClientError('method_not_found', 'Unknown method')

    await expect(
      getBrowserWorktreeSelector(new Map(), outside, callerClient(tooOld))
    ).resolves.toBeUndefined()
  })
})
