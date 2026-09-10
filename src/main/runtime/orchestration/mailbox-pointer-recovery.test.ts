import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

function harness(initial: OrchestrationDb) {
  let db = initial
  let incarnation = 'inc-1'
  const leaf: OrchestrationMailboxLeaf = {
    tabId: 'tab',
    leafId: 'leaf',
    ptyId: 'pty',
    writable: true,
    lastAgentStatus: 'working',
    lastOscTitle: null,
    lastAgentStatusObservedLive: true
  }
  const deps = {
    getDb: () => db,
    deliveryTarget: { resolveTerminalHandle: () => 'term' },
    getLiveLeafForHandle: () => leaf,
    resolveSubmitTarget: () => ({ leaf, terminalHandle: 'term', processIncarnation: incarnation }),
    redriveMailbox: vi.fn()
  } as unknown as PointerDeliveryDependencies<never>
  const owner = new OrchestrationMailboxPointerDelivery(deps)
  owner.attachDatabase(db)
  return {
    owner,
    leaf,
    replace(next: OrchestrationDb) {
      db = next
      owner.attachDatabase(db)
    },
    setIncarnation(next: string) {
      incarnation = next
    }
  }
}

function pending(db: OrchestrationDb, phase = 1, incarnation = 'inc-1') {
  const message = db.insertMessage({ from: 'a', to: 'run:r', subject: 'mail' })
  db.db
    .prepare(`UPDATE messages SET pointer_enter_pending = ?, pointer_pty_id = 'pty',
    pointer_process_incarnation = ? WHERE id = ?`)
    .run(phase, incarnation, message.id)
  return message.id
}

describe('reservation-owned pointer recovery', () => {
  it.each([1, 2, 3])(
    'reconciles a committed phase %s reservation on the next working edge',
    (phase) => {
      const db = new OrchestrationDb(':memory:')
      try {
        const { owner } = harness(db)
        const id = pending(db, phase)
        expect(db.getMessageById(id)?.pointer_enter_pending).toBe(phase)
        owner.observeAgentWorking('pty')
        expect(db.getMessageById(id)).toMatchObject({
          pointer_enter_pending: 0,
          read: 0,
          // A merely-reserved pointer stays redeliverable; a written or submitted one is settled.
          delivered_at: phase === 1 ? null : expect.any(String)
        })
      } finally {
        db.close()
      }
    }
  )

  it('never writes on a working edge while the pane holds no reservation', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { owner } = harness(db)
      const prepare = vi.spyOn(db.db, 'prepare')
      for (let i = 0; i < 500; i++) {
        owner.observeAgentWorking('pty')
      }
      const mutations = prepare.mock.calls
        .map(([sql]) => String(sql).trimStart().toUpperCase())
        .filter((sql) => !sql.startsWith('SELECT'))
      expect(mutations).toEqual([])
      prepare.mockRestore()
    } finally {
      db.close()
    }
  })

  it('reconciles a reservation already committed before attach', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const stranded = pending(db, 2)
      harness(db)
      expect(db.getMessageById(stranded)?.pointer_enter_pending).toBe(0)
    } finally {
      db.close()
    }
  })

  it('clears an already-read reservation instead of leaking it in the index', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const { owner } = harness(db)
      const id = pending(db, 1)
      // A legacy acknowledge marks a message read without clearing its pointer columns.
      db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(id)
      owner.observeAgentWorking('pty')
      expect(db.getMessageById(id)?.pointer_enter_pending).toBe(0)
      // A second edge must find nothing left to write.
      const prepare = vi.spyOn(db.db, 'prepare')
      owner.observeAgentWorking('pty')
      expect(
        prepare.mock.calls
          .map(([sql]) => String(sql).trimStart().toUpperCase())
          .filter((sql) => !sql.startsWith('SELECT'))
      ).toEqual([])
      prepare.mockRestore()
    } finally {
      db.close()
    }
  })

  it('fences a replaced database and a reused PTY incarnation', () => {
    const original = new OrchestrationDb(':memory:')
    const replacement = new OrchestrationDb(':memory:')
    try {
      const { owner, replace, setIncarnation } = harness(original)
      replace(replacement)
      // The detached database is no longer owned, so its rows must be left untouched.
      const detached = pending(original, 2)
      owner.observeAgentWorking('pty')
      expect(original.getMessageById(detached)?.pointer_enter_pending).toBe(2)

      setIncarnation('inc-2')
      const previousIncarnation = pending(replacement, 2)
      owner.observeAgentWorking('pty')
      expect(replacement.getMessageById(previousIncarnation)?.pointer_enter_pending).toBe(2)

      const current = pending(replacement, 2, 'inc-2')
      owner.observeAgentWorking('pty')
      expect(replacement.getMessageById(current)?.pointer_enter_pending).toBe(0)
    } finally {
      original.close()
      replacement.close()
    }
  })
})
