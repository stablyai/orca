import { expect, it } from 'vitest'
import { GeneratedAgentInputNotices } from './generated-agent-input-notices'

const failure = {
  agent: 'claude',
  text: 'recover this exact prompt',
  certainty: 'not-sent',
  handle: 'terminal',
  worktreeId: 'worktree',
  ptyId: null
} as const

it('retires successful pending requests without leaving snapshot work behind', () => {
  for (const count of [100, 1_000]) {
    const notices = new GeneratedAgentInputNotices()
    for (let index = 0; index < count; index += 1) {
      const id = `request-${index}`
      notices.upsert({ ...failure, id, origin: 'window', pending: true })
      notices.settle(id, 'window')
    }
    expect(notices.sizes).toEqual({ notices: 0, rows: 0, dismissed: 0 })
    expect(notices.page(0, 0, 'window').frames).toEqual([])
    // No notices were ever visible, so an empty snapshot has no index rows to visit.
    expect(notices.pageVisits).toBe(0)
  }
})

it('pages only its audience and compacts removed rows without expiring discarded identities', () => {
  for (const count of [100, 1_000]) {
    const notices = new GeneratedAgentInputNotices()
    for (let index = 0; index < count; index += 1) {
      notices.upsert({ ...failure, id: `foreign-${index}`, origin: 'other-window' })
      const id = `own-${index}`
      notices.upsert({ ...failure, id, origin: 'window' })
      notices.dismiss(id, 'window')
    }
    notices.upsert({ ...failure, id: 'kept', origin: 'window' })
    const page = notices.page(0, 0, 'window')
    expect(page.frames.map(({ id }) => id)).toEqual(['kept'])
    // Removal compacts above 2 * live + 16; foreign audiences never enter this seek.
    expect(notices.pageVisits).toBeLessThanOrEqual(18)
    expect(notices.page(0, 0, 'empty-window').frames).toEqual([])
    expect(notices.pageVisits).toBeLessThanOrEqual(18)
    expect(notices.sizes.dismissed).toBe(count)
    expect(notices.upsert({ ...failure, id: 'own-0', origin: 'window' }).retained).toBe(false)
    expect(notices.sizes.notices).toBe(count + 1)
  }
})

// L5: one operation id names one obligation; only the host's own prewrite target-gone answer
// lets it move to a fresh target, and promotion to everyone keeps the window that started it.
it('binds an operation to its text, intent, initiating window and target', () => {
  const notices = new GeneratedAgentInputNotices()
  const op = { ...failure, id: 'op', origin: 'window', pending: true }
  const conflict = { id: 'op', retained: false, conflict: true }
  notices.upsert({ ...op, ptyId: 'pty-1' })
  expect(notices.upsert({ ...op, ptyId: 'pty-2' })).toEqual(conflict)
  notices.prove('op', 'not-sent', true)
  expect(notices.upsert({ ...op, ptyId: 'pty-2' })).toEqual({ id: 'op', retained: true })
  notices.dispatched('op')
  expect(notices.upsert({ ...op, ptyId: 'pty-3' })).toEqual(conflict)
  expect(notices.upsert({ ...op, text: 'another prompt' })).toEqual(conflict)
  expect(notices.upsert({ ...op, submitted: false })).toEqual(conflict)
  notices.upsert({ ...op, origin: null, pending: false, proven: true })
  expect(notices.page(0, 0, null).frames.map(({ id, ptyId }) => ({ id, ptyId }))).toEqual([
    { id: 'op', ptyId: 'pty-2' }
  ])
  expect(notices.upsert({ ...op, origin: 'other-window', pending: false })).toEqual(conflict)
  expect(notices.upsert({ ...op, pending: false })).toEqual({ id: 'op', retained: true })
})

// L6 positive input at the owner: a shown notice whose certainty changes is published once as
// itself with the new metadata; a hidden one publishes nothing.
it('publishes one changed record when a shown notice’s certainty changes', () => {
  const notices = new GeneratedAgentInputNotices()
  const changes: unknown[] = []
  notices.subscribe((change) => changes.push(change))
  notices.upsert({ ...failure, id: 'hidden', origin: 'window', pending: true })
  notices.dispatched('hidden')
  notices.upsert({ ...failure, id: 'shown', origin: 'window' })
  notices.dispatched('shown')
  notices.dispatched('shown')
  expect(changes).toMatchObject([
    { kind: 'added', notice: { id: 'shown', certainty: 'not-sent' } },
    { kind: 'added', notice: { id: 'shown', certainty: 'unconfirmed' } }
  ])
  expect(notices.page(0, 0, 'window').frames.map(({ id }) => id)).toEqual(['shown'])
})

// A2: a reload reveals each request with the certainty it reached, and the outcome its host
// observed is never overridden by a client's inference.
it('reveals not sent before delivery and possibly sent after, keeping an observed outcome', () => {
  const notices = new GeneratedAgentInputNotices()
  const held = { ...failure, origin: 'window', pending: true, connection: 'renderer-1' }
  notices.upsert({ ...held, id: 'waiting' })
  notices.upsert({ ...held, id: 'dispatched' })
  notices.dispatched('dispatched')
  notices.upsert({ ...held, id: 'answered', certainty: 'unconfirmed' })
  notices.prove('answered', 'not-sent')
  notices.revealPending('window', 'renderer-2')
  notices.upsert({ ...held, id: 'answered', pending: false, certainty: 'unconfirmed' })
  expect(
    notices.page(0, 0, 'window').frames.map(({ id, certainty }) => ({ id, certainty }))
  ).toEqual([
    { id: 'waiting', certainty: 'not-sent' },
    { id: 'dispatched', certainty: 'unconfirmed' },
    { id: 'answered', certainty: 'not-sent' }
  ])
  // A frame seen possibly taken stays possibly sent whatever its client reports afterwards.
  notices.frameSettled('dispatched', 'unknown')
  notices.upsert({ ...held, id: 'dispatched', pending: false, reported: true })
  expect(notices.noticeOf('dispatched')?.certainty).toBe('unconfirmed')
})

// L5 / r37217-q3-growth #6: one fresh target per proven target-gone answer, and the host receipt's
// runtime, pairing and window never change; a same-host fresh target moves the terminal address.
it('grants one fresh target per target-gone answer and never replaces the host receipt', () => {
  const notices = new GeneratedAgentInputNotices()
  const host = { environmentId: 'env', runtimeId: 'h1', pairingRevision: 1, window: 'w' }
  const op = { ...failure, id: 'op', origin: 'window', pending: true, handle: 'term-a' }
  const conflict = { id: 'op', retained: false, conflict: true }
  notices.upsert({ ...op, owner: { ...host, terminal: 'term-a' } })
  notices.prove('op', 'not-sent', true)
  expect(
    notices.upsert({ ...op, handle: 'term-b', owner: { ...host, terminal: 'term-b' } })
  ).toEqual({ id: 'op', retained: true })
  expect(notices.upsert({ ...op, handle: 'term-c' })).toEqual(conflict)
  notices.prove('op', 'not-sent', true)
  expect(notices.upsert({ ...op, handle: 'term-b', owner: { ...host, runtimeId: 'h2' } })).toEqual(
    conflict
  )
  // The copy a host is owed names the fresh target's terminal.
  notices.upsert({ ...op, handle: 'term-b', pending: false })
  expect(notices.commands.of('op')).toMatchObject({
    kind: 'register',
    owner: { terminal: 'term-b' }
  })
})

// L5 after projection retirement: once the window's copy gave way to its host's, the id still
// refuses another obligation, and the same one is answered as kept without a second local copy.
it('keeps an operation identity after its copy gives way to the host', () => {
  const notices = new GeneratedAgentInputNotices()
  const host = { environmentId: 'env', runtimeId: 'h1', pairingRevision: 1, window: 'w' }
  notices.upsert({ ...failure, id: 'op', origin: 'window', owner: host })
  notices.observeHost('op', 'window', host)
  expect(notices.sizes.notices).toBe(0)
  const again = { ...failure, id: 'op', origin: 'window' }
  expect(notices.upsert({ ...again, text: 'another prompt' })).toMatchObject({ conflict: true })
  expect(notices.upsert({ ...again, submitted: false })).toMatchObject({ conflict: true })
  expect(notices.upsert({ ...again, origin: 'other-window' })).toMatchObject({ conflict: true })
  expect(notices.upsert(again)).toEqual({ id: 'op', retained: true })
  expect(notices.page(0, 0, 'window').frames).toEqual([])
})

// Ruling acceptance 6: a window's owed discards page within the snapshot byte bound however many
// there are, each exactly once across pages, even when some are applied between pages.
it.each([1_000, 10_000])('pages %i owed discards within the page bound', (count) => {
  const notices = new GeneratedAgentInputNotices()
  const host = { environmentId: 'env', runtimeId: 'h1', pairingRevision: 1, window: 'w' }
  for (let index = 0; index < count; index += 1) {
    notices.dismiss(`gone-${index}-${'x'.repeat(100)}`, 'window', host)
  }
  notices.upsert({ ...failure, id: 'kept', origin: 'window' })
  const seen: string[] = []
  let shown: string[] = []
  let pages = 0
  let appliedUnsent = 0
  for (let from: { cursor: number; offset: number } | null = { cursor: 0, offset: 0 }; from;) {
    const page = notices.page(from.cursor, from.offset, 'window')
    pages += 1
    expect(JSON.stringify(page).length).toBeLessThan(1.1 * 1024 * 1024)
    seen.push(...(page.withheld ?? []))
    shown = shown.concat(page.frames.map(({ id }) => id))
    if (pages === 1 && page.next) {
      // Applied by its host between pages: never shifts what is still owed.
      notices.commandAnswered(notices.commands.of(`gone-${count - 1}-${'x'.repeat(100)}`)!, 'held')
      appliedUnsent = 1
    }
    from = page.next
  }
  expect(new Set(seen).size).toBe(seen.length)
  expect(seen.length).toBe(count - appliedUnsent)
  expect(shown).toEqual(['kept'])
  // Each page carries close to a full bound of ids: pages grow with the bytes owed, not more.
  expect(pages).toBeLessThanOrEqual(Math.ceil((count * 120) / (1024 * 1024)) + 2)
})
