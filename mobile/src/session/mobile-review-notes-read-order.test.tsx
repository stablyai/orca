import { createElement, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileSessionDiffComments } from './use-mobile-session-diff-comments'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcResponse } from '../transport/types'

vi.mock('../platform/haptics', () => ({
  triggerSuccess: () => {},
  triggerError: () => {},
  triggerSelection: () => {}
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))

let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))

const originalNote: DiffComment = {
  id: 'existing',
  worktreeId: 'wt',
  filePath: 'a.ts',
  lineNumber: 1,
  body: 'Existing note',
  createdAt: 1,
  side: 'modified'
}

function deferredReply() {
  let resolve: (reply: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function accepted(result: unknown): RpcResponse {
  return { ok: true, id: 'reply', result, _meta: { runtimeId: 'runtime-1' } }
}

async function mountNotes(initial: DiffComment[] = []) {
  const reads: ReturnType<typeof deferredReply>[] = []
  let mutation = Promise.resolve(accepted({}))
  let model: ReturnType<typeof useMobileSessionDiffComments> | undefined
  let visible: DiffComment[] = []
  let visibleBusy = false
  let worktreeId = 'wt'
  let hostId = 'host-a'
  let executionHost: ExecutionHostId | undefined
  const client = {
    sendRequest: vi.fn(async (method: string, _params?: unknown): Promise<RpcResponse> => {
      if (method === 'worktree.show') {
        const reply = deferredReply()
        reads.push(reply)
        return reply.promise
      }
      expect(method).toBe('worktree.set')
      return mutation
    })
  }
  function Harness() {
    const [comments, setDiffComments] = useState(initial)
    visible = comments
    const diffCommentsRef = useRef(comments)
    diffCommentsRef.current = comments
    const [diffCommentBusy, setDiffCommentBusy] = useState(false)
    visibleBusy = diffCommentBusy
    model = useMobileSessionDiffComments(
      mountFixture<Parameters<typeof useMobileSessionDiffComments>[0]>({
        worktreeId,
        hostId,
        isFloatingWorkspaceRoute: false,
        client,
        connState: 'connected',
        setDiffComments,
        diffCommentsRef,
        diffCommentBusy,
        setDiffCommentBusy,
        setPendingDiffNotesDelivery: () => {},
        showToast: () => {}
      })
    )
    return null
  }
  const renderHarness = () =>
    createElement(
      WorkspaceExecutionHostContext.Provider,
      { value: executionHost },
      createElement(Harness)
    )
  await act(async () => {
    renderer = create(renderHarness())
  })
  return {
    notes: () => visible,
    busy: () => visibleBusy,
    calls: () => client.sendRequest.mock.calls,
    async workspace(nextHost: string, nextWorktree: string, nextExecutionHost?: ExecutionHostId) {
      hostId = nextHost
      worktreeId = nextWorktree
      executionHost = nextExecutionHost
      await act(async () => {
        renderer?.update(renderHarness())
      })
    },
    model: () => {
      if (!model) {
        throw new Error('Notes hook not mounted')
      }
      return model
    },
    writeReply: (reply: Promise<RpcResponse>) => {
      mutation = reply
    },
    async refuse(index: number) {
      const read = reads[index]
      if (!read) {
        throw new Error(`Missing read ${index}`)
      }
      await act(async () => {
        read.resolve({
          ok: false,
          id: 'reply',
          error: { code: 'unavailable', message: 'Read failed' },
          _meta: { runtimeId: 'runtime-1' }
        })
        await read.promise
      })
    },
    async missingRecord(index: number) {
      const read = reads[index]
      if (!read) {
        throw new Error(`Missing read ${index}`)
      }
      await act(async () => {
        read.resolve(accepted({}))
        await read.promise
      })
    },
    async reply(index: number, notes: readonly DiffComment[]) {
      const read = reads[index]
      if (!read) {
        throw new Error(`Missing read ${index}`)
      }
      await act(async () => {
        read.resolve(accepted({ worktree: { diffComments: notes } }))
        await read.promise
      })
    }
  }
}

it('preserves an acknowledged added note against an older background read', async () => {
  const notes = await mountNotes()
  await notes.reply(0, [])
  let staleRead: Promise<void> | undefined
  act(() => {
    staleRead = notes.model().loadDiffComments()
  })
  await act(async () => {
    expect(await notes.model().addDiffCommentForFile('a.ts', 1, 'Do not lose me')).toBe(true)
  })
  expect(notes.notes()).toHaveLength(1)
  await notes.reply(1, [])
  await act(async () => {
    await staleRead
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['Do not lose me'])
})

it.each(['delete', 'deliver'] as const)(
  'does not resurrect a note after acknowledged %s',
  async (action) => {
    const notes = await mountNotes([originalNote])
    await notes.reply(0, [originalNote])
    const delivered = notes.notes()
    let staleRead: Promise<void> | undefined
    act(() => {
      staleRead = notes.model().loadDiffComments()
    })
    await act(async () => {
      if (action === 'delete') {
        await notes.model().deleteDiffCommentForFile(originalNote.id)
      } else {
        await notes.model().clearDeliveredDiffComments(delivered)
      }
    })
    expect(notes.notes()).toEqual([])
    await notes.reply(1, [originalNote])
    await act(async () => {
      await staleRead
    })
    expect(notes.notes()).toEqual([])
  }
)

it('ignores reads started during a pending write and admits a fresh read after it commits', async () => {
  const notes = await mountNotes()
  await notes.reply(0, [])
  const write = deferredReply()
  notes.writeReply(write.promise)
  let saving: Promise<boolean> | undefined
  act(() => {
    saving = notes.model().addDiffCommentForFile('a.ts', 1, 'Pending note')
  })
  let staleLoad: Promise<void> | undefined
  act(() => {
    staleLoad = notes.model().loadDiffComments()
  })
  await notes.reply(1, [])
  await act(async () => {
    await staleLoad
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['Pending note'])
  await act(async () => {
    write.resolve(accepted({}))
    expect(await saving).toBe(true)
  })
  const confirmed = notes.notes()
  let freshLoad: Promise<void> | undefined
  act(() => {
    freshLoad = notes.model().loadDiffComments()
  })
  await notes.reply(2, [...confirmed, { ...originalNote, id: 'desktop-note' }])
  await act(async () => {
    await freshLoad
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['Pending note', 'Existing note'])
})

it('serializes same-frame additions and deletion against the latest acknowledged note list', async () => {
  const notes = await mountNotes([originalNote])
  await notes.reply(0, [originalNote])
  await act(async () => {
    const results = await Promise.all([
      notes.model().addDiffCommentForFile('a.ts', 1, 'First'),
      notes.model().addDiffCommentForFile('b.ts', 2, 'Second'),
      notes.model().deleteDiffCommentForFile(originalNote.id)
    ])
    expect(results.slice(0, 2)).toEqual([true, true])
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['First', 'Second'])
  const writes = notes.calls().filter(([method]) => method === 'worktree.set')
  expect(writes).toHaveLength(3)
  expect(writes[2]?.[1]).toEqual({ worktree: 'id:wt', diffComments: notes.notes() })
})

it.each([true, false])(
  'rebases delivery cleanup after a pending addition settles: saved=%s',
  async (saved) => {
    const notes = await mountNotes([originalNote])
    await notes.reply(0, [originalNote])
    const delivered = notes.notes()
    const write = deferredReply()
    notes.writeReply(write.promise)
    let adding: Promise<boolean> | undefined
    await act(async () => {
      adding = notes.model().addDiffCommentForFile('b.ts', 2, 'New note')
    })
    let cleaning: Promise<void> | undefined
    act(() => {
      cleaning = notes.model().clearDeliveredDiffComments(delivered)
    })
    expect(notes.calls().filter(([method]) => method === 'worktree.set')).toHaveLength(1)
    notes.writeReply(Promise.resolve(accepted({})))
    await act(async () => {
      write.resolve(
        saved
          ? accepted({})
          : {
              ok: false,
              id: 'reply',
              error: { code: 'conflict', message: 'Write refused' },
              _meta: { runtimeId: 'runtime-1' }
            }
      )
      expect(await adding).toBe(saved)
      await cleaning
    })
    expect(notes.notes().map((note) => note.body)).toEqual(saved ? ['New note'] : [])
    const writes = notes.calls().filter(([method]) => method === 'worktree.set')
    expect(writes).toHaveLength(2)
    expect(writes[1]?.[1]).toEqual({ worktree: 'id:wt', diffComments: notes.notes() })
  }
)

it('keeps old-workspace rollback and busy completion from changing a new workspace mutation', async () => {
  const notes = await mountNotes()
  await notes.reply(0, [])
  const oldWrite = deferredReply()
  notes.writeReply(oldWrite.promise)
  let oldAdding: Promise<boolean> | undefined
  await act(async () => {
    oldAdding = notes.model().addDiffCommentForFile('a.ts', 1, 'Old host note')
  })
  await notes.workspace('host-b', 'wt-2')
  await notes.reply(1, [])
  const newWrite = deferredReply()
  notes.writeReply(newWrite.promise)
  let newAdding: Promise<boolean> | undefined
  await act(async () => {
    newAdding = notes.model().addDiffCommentForFile('b.ts', 2, 'New host note')
  })
  expect(notes.busy()).toBe(true)
  await act(async () => {
    oldWrite.resolve({
      ok: false,
      id: 'reply',
      error: { code: 'conflict', message: 'Old write failed' },
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(await oldAdding).toBe(false)
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['New host note'])
  expect(notes.busy()).toBe(true)
  await act(async () => {
    newWrite.resolve(accepted({}))
    expect(await newAdding).toBe(true)
  })
  expect(notes.busy()).toBe(false)
  expect(notes.notes()[0]?.worktreeId).toBe('wt-2')
})

it('waits for the initial desktop note baseline before writing a complete replacement list', async () => {
  const notes = await mountNotes()
  let adding: Promise<boolean> | undefined
  await act(async () => {
    adding = notes.model().addDiffCommentForFile('b.ts', 2, 'New note')
  })
  expect(notes.calls().filter(([method]) => method === 'worktree.set')).toEqual([])
  await notes.reply(0, [originalNote])
  await act(async () => {
    expect(await adding).toBe(true)
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['Existing note', 'New note'])
  const write = notes.calls().find(([method]) => method === 'worktree.set')
  expect(write?.[1]).toEqual({ worktree: 'id:wt', diffComments: notes.notes() })
})

it('does not replace the desktop notes when a successful read omits its workspace record', async () => {
  const notes = await mountNotes()
  let adding: Promise<boolean> | undefined
  await act(async () => {
    adding = notes.model().addDiffCommentForFile('b.ts', 2, 'Keep existing desktop notes')
  })
  await notes.missingRecord(0)
  await act(async () => {
    expect(await adding).toBe(false)
  })
  expect(notes.calls().filter(([method]) => method === 'worktree.set')).toEqual([])
  expect(notes.busy()).toBe(false)
  let loading: Promise<void> | undefined
  act(() => {
    loading = notes.model().loadDiffComments()
  })
  await notes.reply(1, [originalNote])
  await act(async () => {
    await loading
    expect(await notes.model().addDiffCommentForFile('b.ts', 2, 'After valid baseline')).toBe(true)
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['Existing note', 'After valid baseline'])
})

it('waits for the new workspace baseline and preserves its desktop notes when editing immediately', async () => {
  const notes = await mountNotes([originalNote])
  await notes.reply(0, [originalNote])
  await notes.workspace('host-b', 'wt-2')
  let adding: Promise<boolean> | undefined
  await act(async () => {
    adding = notes.model().addDiffCommentForFile('b.ts', 2, 'New workspace note')
  })
  expect(notes.calls().filter(([method]) => method === 'worktree.set')).toEqual([])
  await notes.reply(1, [{ ...originalNote, id: 'existing-b', worktreeId: 'wt-2' }])
  await act(async () => {
    expect(await adding).toBe(true)
  })
  expect(notes.notes().map((note) => note.id)).toContain('existing-b')
  expect(notes.notes().every((note) => note.worktreeId === 'wt-2')).toBe(true)
  const write = notes.calls().find(([method]) => method === 'worktree.set')
  expect(write?.[1]).toEqual({ worktree: 'id:wt-2', diffComments: notes.notes() })
})

it('refuses to replace unknown notes after a failed baseline and recovers on a fresh read', async () => {
  const notes = await mountNotes()
  let adding: Promise<boolean> | undefined
  await act(async () => {
    adding = notes.model().addDiffCommentForFile('a.ts', 1, 'Wait for notes')
  })
  await notes.refuse(0)
  await act(async () => {
    expect(await adding).toBe(false)
  })
  expect(notes.calls().filter(([method]) => method === 'worktree.set')).toEqual([])
  expect(notes.busy()).toBe(false)
  let loading: Promise<void> | undefined
  act(() => {
    loading = notes.model().loadDiffComments()
  })
  await notes.reply(1, [originalNote])
  await act(async () => {
    await loading
    expect(await notes.model().addDiffCommentForFile('a.ts', 1, 'After recovery')).toBe(true)
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['Existing note', 'After recovery'])
})

it('loads a fresh baseline when execution authority changes under the same paired host and workspace ID', async () => {
  const notes = await mountNotes()
  await notes.reply(0, [originalNote])
  await notes.workspace('host-a', 'wt', 'runtime:other-server')
  let adding: Promise<boolean> | undefined
  await act(async () => {
    adding = notes.model().addDiffCommentForFile('b.ts', 2, 'Server note')
  })
  expect(notes.calls().filter(([method]) => method === 'worktree.set')).toEqual([])
  await notes.reply(1, [{ ...originalNote, id: 'server-existing', body: 'Server baseline' }])
  await act(async () => {
    expect(await adding).toBe(true)
  })
  expect(notes.notes().map((note) => note.body)).toEqual(['Server baseline', 'Server note'])
})
