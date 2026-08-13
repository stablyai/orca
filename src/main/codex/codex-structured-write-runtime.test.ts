import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodexStructuredWriteAuthority } from './codex-structured-write-runtime'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function fixture(): { state: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-structured-runtime-'))
  roots.push(root)
  const worktree = join(root, 'worktree')
  const gitDir = join(root, 'repo.git', 'worktrees', 'bounded')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`)
  writeFileSync(join(worktree, 'source.txt'), 'before\n')
  return { state: join(root, 'state'), worktree: realpathSync(worktree) }
}

describe('createCodexStructuredWriteAuthority', () => {
  it('requires host request authority and refuses the same admitted turn after restart', async () => {
    const { state, worktree } = fixture()
    const first = await createCodexStructuredWriteAuthority({ stateDirectory: state })
    await first.bindSession('session-1', worktree)
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'change source.txt only' }]
    }
    await expect(
      first.openTurn({ sessionId: 'session-1', clientMessageId: 'plain', body, fence: 7 })
    ).resolves.toBeNull()
    const requestAuthority = {
      effectAuthority: 'local_structured_write' as const,
      requestReceiptId: 'c'.repeat(64)
    }
    const epoch = await first.openTurn({
      sessionId: 'session-1',
      clientMessageId: 'edit-1',
      body,
      fence: 7,
      requestAuthority
    })
    expect(epoch).toBe(2)
    first.bindTurn('session-1', 'thread-1', 'turn-1', epoch as number)
    first.observeNotification('session-1', 'item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'fileChange',
        id: 'item-1',
        changes: [{ path: 'source.txt', diff: '@@', kind: { type: 'update' } }]
      }
    })
    await expect(
      first.reviewServerRequest('session-1', 'item/fileChange/requestApproval', {
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        grantRoot: worktree
      })
    ).resolves.toEqual({ handled: true, result: { decision: 'accept' } })
    first.observeNotification('session-1', 'item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'item-1', status: 'completed' }
    })
    await first.flushReceipts()
    const trace = JSON.parse(
      readFileSync(join(state, 'codex-structured-write', 'operational-trace.json'), 'utf8')
    ) as { receipts: { outcome: string }[] }
    expect(trace.receipts).toMatchObject([{ outcome: 'completed' }])

    const restarted = await createCodexStructuredWriteAuthority({ stateDirectory: state })
    await restarted.bindSession('session-1', worktree)
    await expect(
      restarted.openTurn({
        sessionId: 'session-1',
        clientMessageId: 'edit-1',
        body,
        fence: 7,
        requestAuthority
      })
    ).resolves.toBeNull()
  })

  it('fails closed when durable enforcement evidence is malformed', async () => {
    const { state } = fixture()
    const storeDirectory = join(state, 'codex-structured-write')
    mkdirSync(storeDirectory, { recursive: true })
    const digest = 'd'.repeat(64)
    writeFileSync(
      join(storeDirectory, 'host-enforcement-receipts.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        receipts: [
          {
            protocolVersion: 1,
            requestReceiptId: digest,
            effectDomain: 'hosted_connector',
            sessionId: 'forged',
            turnEpoch: 1,
            fence: 0,
            clientMessageId: 'message',
            threadId: 'thread',
            turnId: 'turn',
            requestDigest: digest,
            toolUseId: 'tool',
            changePlanDigest: digest,
            worktreeRoot: '/tmp/worktree',
            capabilityHandleDigest: digest,
            before: [],
            admittedAtMs: Date.now()
          }
        ]
      })}\n`
    )
    await expect(createCodexStructuredWriteAuthority({ stateDirectory: state })).rejects.toThrow(
      'invalid receipts'
    )
  })

  it('reports a malformed operational trace without blocking enforcement', async () => {
    const { state, worktree } = fixture()
    const storeDirectory = join(state, 'codex-structured-write')
    mkdirSync(storeDirectory, { recursive: true })
    writeFileSync(join(storeDirectory, 'operational-trace.json'), '{not-json\n')
    const onTraceError = vi.fn()

    const authority = await createCodexStructuredWriteAuthority({
      stateDirectory: state,
      onTraceError
    })
    await expect(authority.bindSession('session-1', worktree)).resolves.toBeUndefined()
    expect(onTraceError).toHaveBeenCalledOnce()
  })

  it('drains a failed outcome generated by session revocation', async () => {
    const { state, worktree } = fixture()
    const authority = await createCodexStructuredWriteAuthority({ stateDirectory: state })
    await authority.bindSession('session-1', worktree)
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'change source.txt only' }]
    }
    const epoch = await authority.openTurn({
      sessionId: 'session-1',
      clientMessageId: 'edit-1',
      body,
      fence: 7,
      requestAuthority: {
        effectAuthority: 'local_structured_write',
        requestReceiptId: 'e'.repeat(64)
      }
    })
    authority.bindTurn('session-1', 'thread-1', 'turn-1', epoch as number)
    authority.observeNotification('session-1', 'item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'fileChange',
        id: 'item-1',
        changes: [{ path: 'source.txt', diff: '@@', kind: { type: 'update' } }]
      }
    })
    await authority.reviewServerRequest('session-1', 'item/fileChange/requestApproval', {
      itemId: 'item-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      grantRoot: worktree
    })

    authority.revokeSession('session-1')
    await authority.flushReceipts()
    const trace = JSON.parse(
      readFileSync(join(state, 'codex-structured-write', 'operational-trace.json'), 'utf8')
    ) as { receipts: { outcome: string }[] }
    expect(trace.receipts).toMatchObject([{ outcome: 'failed' }])
  })
})
