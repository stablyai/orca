import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as StructuredWriteManifest from './codex-structured-write-manifest'

const roots: string[] = []
let afterSnapshot: (() => void) | null = null

vi.mock('./codex-structured-write-manifest', async (importOriginal) => {
  const original = await importOriginal<typeof StructuredWriteManifest>()
  return {
    ...original,
    snapshotChanges: async (...args: Parameters<typeof original.snapshotChanges>) => {
      const manifest = await original.snapshotChanges(...args)
      afterSnapshot?.()
      return manifest
    }
  }
})

const { admitStructuredFileChange } = await import('./codex-structured-write-admission')
const { snapshotLinkedWorktreeRoot } = await import('./codex-structured-write-manifest')

afterEach(() => {
  afterSnapshot = null
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function linkedWorktree(): { fixture: string; root: string; gitDir: string } {
  const fixture = mkdtempSync(join(tmpdir(), 'orca-admission-race-'))
  roots.push(fixture)
  const root = join(fixture, 'worktree')
  const gitDir = join(fixture, 'canonical.git', 'worktrees', 'bounded')
  mkdirSync(root, { recursive: true })
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), `${join(root, '.git')}\n`)
  return { fixture, root: realpathSync(root), gitDir }
}

describe('Codex structured write admission races', () => {
  it('declines when the selected worktree inode is replaced during admission', async () => {
    const fixture = linkedWorktree()
    const consumeLease = vi.fn()
    const worktree = await snapshotLinkedWorktreeRoot(fixture.root)
    afterSnapshot = () => {
      renameSync(fixture.root, join(fixture.fixture, 'displaced-worktree'))
      mkdirSync(fixture.root)
      writeFileSync(join(fixture.root, '.git'), `gitdir: ${fixture.gitDir}\n`)
      writeFileSync(join(fixture.gitDir, 'gitdir'), `${join(fixture.root, '.git')}\n`)
    }

    await expect(
      admitStructuredFileChange({
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        grantRoot: fixture.root,
        expectedWorktreeIdentity: worktree.identity,
        lease: {
          handle: 'handle-1',
          requestReceiptId: 'request-1',
          sessionId: 'session-1',
          turnEpoch: 1,
          fence: 1,
          clientMessageId: 'message-1',
          requestDigest: 'a'.repeat(64),
          worktreeRoot: fixture.root,
          threadId: 'thread-1',
          turnId: 'turn-1',
          state: 'issued'
        },
        observed: {
          sessionId: 'session-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          changes: [{ path: 'new.txt', diff: '+new', kind: { type: 'add' } }],
          changePlanDigest: 'b'.repeat(64),
          before: null,
          admission: null
        },
        authorization: {
          authorizeTurn: () => null,
          consumeLease,
          onReceipt: () => {}
        },
        now: () => 1,
        isCurrent: () => true
      })
    ).resolves.toEqual({ handled: true, result: { decision: 'decline' } })
    expect(consumeLease).not.toHaveBeenCalled()
  })
})
