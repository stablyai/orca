import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../shared/diff-comment-types'
import { mergeDiffCommentMutation } from '../../shared/diff-comment-mutation'
import { RuntimeClient } from '../runtime/client'
import { WORKTREE_NOTES_HANDLERS } from './worktree-notes'

const WORKTREE_ID = 'repo-1::/work/app'

function note(id: string, filePath: string): DiffComment {
  return {
    id,
    worktreeId: WORKTREE_ID,
    filePath,
    source: 'diff',
    lineNumber: 3,
    body: id,
    createdAt: 1,
    side: 'modified'
  }
}

// The host merges against the sent base; another device saves `phone` after the CLI read the list.
function hostWithConcurrentWrite(initial: DiffComment[]): {
  client: RuntimeClient
  stored: () => string[]
} {
  let notes = initial
  const client = new RuntimeClient('/tmp/orca-notes-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (method: string, params: unknown) => {
    const record = () => ({ id: WORKTREE_ID, path: '/work/app', diffComments: notes })
    if (method === 'worktree.show') {
      const shown = { worktree: record() }
      notes = [...notes, note('phone', 'src/a.ts')]
      return { id: 'r', ok: true, result: shown, _meta: { runtimeId: 'rt' } }
    }
    if (typeof params !== 'object' || params === null || !('diffComments' in params)) {
      throw new Error(`unexpected ${method}`)
    }
    const requested: DiffComment[] = Array.isArray(params.diffComments) ? params.diffComments : []
    const base: unknown = 'diffCommentsBase' in params ? params.diffCommentsBase : undefined
    notes = Array.isArray(base) ? mergeDiffCommentMutation(base, notes, requested) : requested
    return { id: 'r', ok: true, result: { worktree: record() }, _meta: { runtimeId: 'rt' } }
  })
  return { client, stored: () => notes.map((entry) => entry.id) }
}

function run(command: string, client: RuntimeClient, flags: [string, string | boolean][]) {
  return WORKTREE_NOTES_HANDLERS[command]({
    flags: new Map([['worktree', `id:${WORKTREE_ID}`], ...flags]),
    client,
    cwd: '/work/app',
    json: true
  })
}

describe('worktree notes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a note saved elsewhere while adding one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const host = hostWithConcurrentWrite([note('old', 'src/b.ts')])

    await run('worktree notes add', host.client, [
      ['file', 'src/a.ts'],
      ['line', '4'],
      ['body', 'new finding']
    ])

    expect(host.stored()).toHaveLength(3)
    expect(host.stored().slice(0, 2)).toEqual(['old', 'phone'])
  })

  it('clears only the notes it read on that file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const host = hostWithConcurrentWrite([note('a1', 'src/a.ts'), note('b1', 'src/b.ts')])

    await run('worktree notes clear', host.client, [['file', 'src/a.ts']])

    expect(host.stored()).toEqual(['b1', 'phone'])
  })
})
