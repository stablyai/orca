import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { resolveSourceControlAiLinkedIssue } from './source-control-ai-linked-issue'

const LOCAL_PATH = path.resolve('/workspace/repo-feature')
const LOCAL_ID = `repo-1::${LOCAL_PATH}`
const REMOTE_PATH = '/home/tester/wt'
const REMOTE_ID = `repo-1::${REMOTE_PATH}`

function makeStore(meta: Record<string, { linkedIssue?: number | null }>): Store {
  return {
    getWorktreeMeta: vi.fn((worktreeId: string) => meta[worktreeId])
  } as unknown as Store
}

describe('resolveSourceControlAiLinkedIssue', () => {
  it('reads meta with the raw id when the id matches the request path', () => {
    const store = makeStore({ [LOCAL_ID]: { linkedIssue: 123 } })

    expect(
      resolveSourceControlAiLinkedIssue(store, {
        worktreeId: LOCAL_ID,
        worktreePath: LOCAL_PATH,
        repoId: 'repo-1'
      })
    ).toBe(123)
    expect(store.getWorktreeMeta).toHaveBeenCalledWith(LOCAL_ID)
  })

  it('keeps the folder-repo instance suffix in the meta key while validating the stripped path', () => {
    const instanceId = `${LOCAL_ID}::workspace:${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`
    const store = makeStore({ [instanceId]: { linkedIssue: 9 } })

    expect(
      resolveSourceControlAiLinkedIssue(store, {
        worktreeId: instanceId,
        worktreePath: LOCAL_PATH
      })
    ).toBe(9)
    expect(store.getWorktreeMeta).toHaveBeenCalledWith(instanceId)
  })

  // Why: the desktop renderer derives `worktreePath` from `worktreeId`, so it can
  // never send a mismatched pair — these cases model an independent caller (relay,
  // CLI, future in-process caller) and assert the guard fails closed for them.
  // They are not evidence that a stale renderer context is rejected; it is not.
  it('rejects an independently supplied id whose path does not match the request', () => {
    const store = makeStore({ [LOCAL_ID]: { linkedIssue: 123 } })

    expect(
      resolveSourceControlAiLinkedIssue(store, {
        worktreeId: LOCAL_ID,
        worktreePath: path.resolve('/workspace/repo-other')
      })
    ).toBeNull()
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
  })

  it('accepts the resolved worktree path as an alternate local candidate', () => {
    const store = makeStore({ [LOCAL_ID]: { linkedIssue: 5 } })

    expect(
      resolveSourceControlAiLinkedIssue(
        store,
        { worktreeId: LOCAL_ID, worktreePath: path.resolve('/workspace/symlinked') },
        LOCAL_PATH
      )
    ).toBe(5)
  })

  it('rejects an independently supplied id whose repoId contradicts the request repoId', () => {
    const store = makeStore({ [LOCAL_ID]: { linkedIssue: 123 } })

    expect(
      resolveSourceControlAiLinkedIssue(store, {
        worktreeId: LOCAL_ID,
        worktreePath: LOCAL_PATH,
        repoId: 'repo-2'
      })
    ).toBeNull()
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
  })

  it('fails closed on an empty-string repoId instead of skipping the cross-check', () => {
    const store = makeStore({ [LOCAL_ID]: { linkedIssue: 123 } })

    expect(
      resolveSourceControlAiLinkedIssue(store, {
        worktreeId: LOCAL_ID,
        worktreePath: LOCAL_PATH,
        repoId: ''
      })
    ).toBeNull()
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
  })

  it('compares SSH remote paths as raw strings', () => {
    const store = makeStore({ [REMOTE_ID]: { linkedIssue: 77 } })

    expect(
      resolveSourceControlAiLinkedIssue(store, {
        worktreeId: REMOTE_ID,
        worktreePath: `${REMOTE_PATH}/`,
        connectionId: 'conn-1'
      })
    ).toBe(77)
  })

  it('matches SSH remote paths from a Windows host without path rewriting', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const store = makeStore({ [REMOTE_ID]: { linkedIssue: 77 } })

      expect(
        resolveSourceControlAiLinkedIssue(store, {
          worktreeId: REMOTE_ID,
          worktreePath: REMOTE_PATH,
          connectionId: 'conn-1'
        })
      ).toBe(77)
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })

  it('returns null without touching the store when no id is supplied', () => {
    const store = makeStore({ [LOCAL_ID]: { linkedIssue: 123 } })

    expect(resolveSourceControlAiLinkedIssue(store, { worktreePath: LOCAL_PATH })).toBeNull()
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
  })

  it('tolerates a store without a meta accessor', () => {
    expect(
      resolveSourceControlAiLinkedIssue({} as Store, {
        worktreeId: LOCAL_ID,
        worktreePath: LOCAL_PATH
      })
    ).toBeNull()
  })

  it('returns null for unparsable ids and unlinked or unusable meta', () => {
    expect(
      resolveSourceControlAiLinkedIssue(makeStore({}), {
        worktreeId: 'no-separator',
        worktreePath: LOCAL_PATH
      })
    ).toBeNull()
    for (const linkedIssue of [null, undefined, Number.NaN, 0, -7, 12.9]) {
      expect(
        resolveSourceControlAiLinkedIssue(makeStore({ [LOCAL_ID]: { linkedIssue } }), {
          worktreeId: LOCAL_ID,
          worktreePath: LOCAL_PATH
        })
      ).toBeNull()
    }
  })

  it('does not fall back to a GitLab-linked issue', () => {
    const store = {
      getWorktreeMeta: vi.fn(() => ({ linkedIssue: null, linkedGitLabIssue: 456 }))
    } as unknown as Store

    expect(
      resolveSourceControlAiLinkedIssue(store, {
        worktreeId: LOCAL_ID,
        worktreePath: LOCAL_PATH
      })
    ).toBeNull()
  })
})
