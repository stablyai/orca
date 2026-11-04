import { createElement, useEffect, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeDiffCommentMutation } from '../../../src/shared/diff-comment-mutation'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

import { useMobileSessionDiffComments } from './use-mobile-session-diff-comments'

vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn(),
  triggerSelection: vi.fn()
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }))

function note(id: string): DiffComment {
  return {
    id,
    worktreeId: 'workspace-1',
    filePath: 'src/a.ts',
    lineNumber: 3,
    body: `note ${id}`,
    createdAt: 1,
    side: 'modified'
  }
}

type SetParams = { diffComments: DiffComment[]; diffCommentsBase?: DiffComment[] }

/** A host holding the stored notes; `merges: false` is a host from before the base field. */
function fakeHost(initial: DiffComment[], options: { merges: boolean }) {
  const host = { notes: initial, holdShow: false, holdSets: false, failNextSet: false }
  const heldShows: (() => void)[] = []
  const heldSets: (() => void)[] = []
  const reply = (result: unknown): RpcResponse => ({
    id: 'x',
    ok: true,
    result,
    _meta: { runtimeId: 'r' }
  })
  const sendRequest = vi.fn((method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'worktree.show') {
      const snapshot = host.notes
      return new Promise((resolve) => {
        const answer = () => resolve(reply({ worktree: { diffComments: snapshot } }))
        if (host.holdShow) {
          heldShows.push(answer)
        } else {
          answer()
        }
      })
    }
    if (method === 'worktree.set') {
      if (host.failNextSet) {
        host.failNextSet = false
        return Promise.resolve({ id: 'x', ok: false, error: { code: 'x', message: 'Disk full' } })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hooks under test send only this shape to worktree.set.
      const { diffComments, diffCommentsBase } = params as SetParams
      return new Promise((resolve) => {
        const apply = () => {
          host.notes =
            options.merges && diffCommentsBase
              ? mergeDiffCommentMutation(diffCommentsBase, host.notes, diffComments)
              : diffComments
          resolve(reply({ worktree: { diffComments: host.notes } }))
        }
        if (host.holdSets) {
          heldSets.push(apply)
        } else {
          apply()
        }
      })
    }
    return new Promise<RpcResponse>(() => {})
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { host, client, heldShows, heldSets, sendRequest }
}

type Notes = ReturnType<typeof useMobileSessionDiffComments>
let renderer: ReactTestRenderer | undefined
let notes: Notes | undefined
let shown: DiffComment[] = []
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  notes = undefined
})

function hook(): Notes {
  if (!notes) {
    throw new Error('notes hook not mounted')
  }
  return notes
}

async function mountNotes(client: RpcClient): Promise<void> {
  function Harness() {
    const [diffComments, setDiffComments] = useState<DiffComment[]>([])
    const diffCommentsRef = useRef(diffComments)
    const [diffCommentBusy, setDiffCommentBusy] = useState(false)
    // Mirrors the session screen, which syncs the ref after each render.
    useEffect(() => {
      diffCommentsRef.current = diffComments
    }, [diffComments])
    shown = diffComments
    const scope = {
      worktreeId: 'workspace-1',
      isFloatingWorkspaceRoute: false,
      client,
      connState: 'connected',
      setDiffComments,
      diffCommentsRef,
      diffCommentBusy,
      setDiffCommentBusy,
      setPendingDiffNotesDelivery: () => {},
      showToast: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member the notes hook reads; a missing one throws on use.
    notes = useMobileSessionDiffComments(scope as never)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
}

const ids = (comments: readonly DiffComment[]) => comments.map((comment) => comment.id)

describe('mobile review notes saved against the host', () => {
  it('saves both notes when two are added in the same frame', async () => {
    const { host, client } = fakeHost([note('a')], { merges: true })
    await mountNotes(client)

    await act(async () => {
      await Promise.all([
        hook().addDiffCommentForFile('src/a.ts', 1, 'first'),
        hook().addDiffCommentForFile('src/a.ts', 2, 'second')
      ])
    })

    expect(host.notes.map((comment) => comment.body)).toEqual(['note a', 'first', 'second'])
    expect(ids(shown)).toEqual(ids(host.notes))
  })

  it('sends only its own change after a failed save, so a host without the merge keeps the note', async () => {
    const { host, client } = fakeHost([note('a'), note('b')], { merges: false })
    await mountNotes(client)
    host.failNextSet = true

    await act(async () => {
      await Promise.all([
        hook().deleteDiffCommentForFile('a'),
        hook().addDiffCommentForFile('src/a.ts', 2, 'added')
      ])
    })

    expect(host.notes.map((comment) => comment.body)).toEqual(['note a', 'note b', 'added'])
    expect(ids(shown)).toEqual(ids(host.notes))
  })
})
