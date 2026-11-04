import { expect, it } from 'vitest'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  nativeChatTurnDiffEditFile,
  nativeChatTurnDiffs
} from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { chat, turn } from './codex-thread-catch-up-contract-test-fixture'

const patch = '@@ -1 +1 @@\n-old\n+new'

async function savedChange() {
  const c = await chat({ now: 1_000 })
  const source = (status?: string, changes?: unknown[]) => ({
    ...turn(1),
    items: [
      {
        type: 'fileChange',
        id: 'patch',
        ...(status === undefined ? {} : { status }),
        ...(changes === undefined ? {} : { changes })
      }
    ]
  })
  await c.open([
    source('completed', [{ path: 'src/app.ts', kind: { type: 'update' }, diff: patch }])
  ])
  const original = c.journal.snapshot().items.find((item) => item.body.kind === 'diff')!
  expect(original.body.kind).toBe('diff')
  const current = () => c.journal.snapshot().items.find((item) => item.itemId === original.itemId)!
  const outcome = () => {
    const messages = projectStructuredItemsToNativeChat(c.journal.snapshot().items)
    return nativeChatTurnDiffs(
      messages,
      messages.map(() => 'turn')
    ).get('turn')
  }
  return { c, source, original, current, outcome }
}

it('uses declined history status without losing the patch or resurrecting it on sparse enrichment', async () => {
  const f = await savedChange()
  await f.c.open([f.source('declined')])
  expect(f.current().body).toMatchObject({
    kind: 'tool-call',
    name: 'Diff',
    input: { path: 'src/app.ts' },
    state: 'failed'
  })
  expect(f.outcome()).toBeUndefined()
  const failed = f.current().body
  expect(failed.kind === 'tool-call' && failed.output).toEqual(
    f.original.body.kind === 'diff' && f.original.body.patch
  )
  await f.c.open([f.source()])
  expect(f.current().body).toEqual(failed)
  expect(f.outcome()).toBeUndefined()
})

it.each(['completed', undefined])(
  'retains the saved successful patch for sparse %s history',
  async (status) => {
    const f = await savedChange()
    await f.c.open([f.source(status)])
    expect(f.current().body).toEqual(f.original.body)
    expect(f.outcome()).toMatchObject({ added: 1, removed: 1 })
    expect(f.outcome()?.files.map((file) => file.path)).toEqual(['src/app.ts'])
    expect(f.outcome()?.files[0]?.edits).toHaveLength(1)
  }
)

it('retains a sparse pending patch until a new import confirms its application', async () => {
  const f = await savedChange()
  await f.c.open([f.source('inProgress')])
  expect(f.current().body).toMatchObject({ kind: 'tool-call', name: 'Diff', state: 'running' })
  expect(f.outcome()).toBeUndefined()
  await f.c.open([f.source('completed')])
  expect(f.current().body).toEqual(f.original.body)
  const outcome = f.outcome()!
  expect(outcome).toMatchObject({ added: 1, removed: 1 })
  expect(outcome.files.map((file) => file.path)).toEqual(['src/app.ts'])
  expect(outcome.files[0]?.edits).toHaveLength(1)
  expect(nativeChatTurnDiffEditFile(outcome.files[0]!.edits[0]!)).toMatchObject({
    path: 'src/app.ts',
    lines: [
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' }
    ]
  })
})
