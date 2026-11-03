import { createElement, useEffect, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeDiffCommentMutation } from '../../../src/shared/diff-comment-mutation'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewCommentActions } from './use-mobile-diff-review-comment-actions'
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
  it('keeps a note added on desktop after the phone loaded when the phone adds and deletes', async () => {
    const { host, client } = fakeHost([note('a')], { merges: true })
    await mountNotes(client)
    host.notes = [...host.notes, note('desktop')]

    await act(async () => {
      await hook().addDiffCommentForFile('src/a.ts', 9, 'from phone')
    })
    await act(async () => hook().deleteDiffCommentForFile('a'))

    expect(ids(host.notes)).toEqual(['desktop', expect.stringMatching(/^mobile-/)])
    expect(ids(shown)).toEqual(ids(host.notes))
  })

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

  it('does not let a slow first load replace a note saved after it', async () => {
    const { host, client, heldShows } = fakeHost([note('a')], { merges: true })
    host.holdShow = true
    await mountNotes(client)

    await act(async () => {
      const adding = hook().addDiffCommentForFile('src/a.ts', 2, 'early')
      heldShows.forEach((answer) => answer())
      await adding
    })

    expect(shown.map((comment) => comment.body)).toEqual(['note a', 'early'])
  })

  it('still shows the loaded notes when a save made before the first load fails', async () => {
    const { host, client, heldShows } = fakeHost([note('a')], { merges: true })
    host.holdShow = true
    host.failNextSet = true
    await mountNotes(client)

    await act(async () => {
      const adding = hook().addDiffCommentForFile('src/a.ts', 2, 'refused')
      heldShows.forEach((answer) => answer())
      await adding
    })

    expect(ids(shown)).toEqual(['a'])
  })

  it('keeps a saved note when a delivered-note cleanup is made while its save is in flight', async () => {
    const { host, client, heldSets } = fakeHost([note('a')], { merges: true })
    await mountNotes(client)
    host.holdSets = true

    let adding: Promise<boolean> = Promise.resolve(false)
    let clearing: Promise<void> = Promise.resolve()
    await act(async () => {
      adding = hook().addDiffCommentForFile('src/a.ts', 2, 'kept')
      clearing = hook().clearDeliveredDiffComments(shown.filter((comment) => comment.id === 'a'))
    })
    await act(async () => {
      // Answer the newest held write first, the order a host can apply two in-flight writes in.
      for (let turn = 0; turn < 4; turn += 1) {
        heldSets.pop()?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await Promise.all([adding, clearing])
    })

    expect(host.notes.map((comment) => comment.body)).toEqual(['kept'])
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

  it('keeps loaded notes on a host without the merge when a note is added before the first load', async () => {
    const { host, client, heldShows } = fakeHost([note('a')], { merges: false })
    host.holdShow = true
    await mountNotes(client)

    await act(async () => {
      const adding = hook().addDiffCommentForFile('src/a.ts', 2, 'early')
      heldShows.forEach((answer) => answer())
      await adding
    })

    expect(host.notes.map((comment) => comment.body)).toEqual(['note a', 'early'])
  })

  it('still sends the full list, so a host without the merge replaces it as before', async () => {
    const { host, client, sendRequest } = fakeHost([note('a')], { merges: false })
    await mountNotes(client)

    await act(async () => {
      await hook().addDiffCommentForFile('src/a.ts', 2, 'phone')
    })

    const sent = sendRequest.mock.calls.find(([method]) => method === 'worktree.set')?.[1]
    expect(sent).toMatchObject({ diffComments: [note('a'), { body: 'phone' }] })
    expect(host.notes.map((comment) => comment.body)).toEqual(['note a', 'phone'])
    expect(shown).toEqual(host.notes)
  })
})

describe('review screen notes saved against the host', () => {
  it('shows the host list after a save, so an edit to a note desktop deleted does not look saved', async () => {
    const { host, client } = fakeHost([note('a'), note('b')], { merges: true })
    let state: ReviewScreenState = {
      kind: 'ready',
      status: { entries: [] },
      branchCompare: null,
      comments: [note('a'), note('b')],
      reviewState: { version: 1, files: {} }
    }
    let actions: ReturnType<typeof useMobileDiffReviewCommentActions> | undefined
    function Harness() {
      const [screenState, setScreenState] = useState(state)
      state = screenState
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the save path reads only these members.
      actions = useMobileDiffReviewCommentActions({
        client,
        connState: 'connected',
        worktreeId: 'workspace-1',
        screenState,
        setScreenState,
        setActionError: () => {},
        sheets: {}
      } as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    host.notes = [note('b')]

    const edited = { ...note('a'), body: 'edited' }
    await act(async () => {
      await actions?.saveCommentsAndReviewState([edited, note('b')], { version: 1, files: {} })
    })

    expect(ids(host.notes)).toEqual(['b'])
    expect(state.kind === 'ready' ? ids(state.comments) : []).toEqual(['b'])
  })
})
