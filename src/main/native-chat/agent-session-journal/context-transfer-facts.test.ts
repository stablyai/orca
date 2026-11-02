import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import type Database from '../../sqlite/sync-database'
import { selectRecoveryDelivery } from '../agent-session-context-transfer-text'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { CONTEXT_TRANSFER_KEYED_SQL, ContextTransferFacts } from './context-transfer-facts'
import type {
  ContextTransferCapture,
  ContextTransferDelivery,
  ContextTransferRecord
} from './context-transfer-record'
import {
  closeContextTransfers,
  currentContextTransferTarget,
  readContextTransfers,
  writeContextTransfer
} from './context-transfer-repository'
import { runJournalTransaction } from './journal-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'

const roots: string[] = []
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const LOOKUP_INDEXES = [
  'agent_session_context_transfer_kind',
  'agent_session_context_transfer_format',
  'agent_session_context_transfer_delivery_target',
  'agent_session_context_transfer_delivery_carrier',
  'agent_session_context_transfer_closure_command'
]

async function database(indexed = true): Promise<Database.Database> {
  const root = await mkdtemp(join(tmpdir(), 'orca-transfer-facts-'))
  roots.push(root)
  const { db } = openTestJournalHostDatabase(root)
  if (!indexed) {
    for (const index of LOOKUP_INDEXES) {
      db.exec(`DROP INDEX ${index}`)
    }
  }
  return db
}

const link = (i: number): AgentSessionProviderHandleLink => ({
  linkId: `L${i}`,
  handle: {
    transport: 'codex-app-server',
    agent: 'codex',
    nativeId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
  },
  origin: 'created',
  mintedAtFence: 1,
  observedAt: 1
})

const capture: ContextTransferCapture = {
  selectionVersion: 1,
  messages: [
    {
      itemId: 'saved',
      revision: 1,
      sequence: 1,
      sequenceIndex: 0,
      role: 'assistant',
      kind: 'message',
      text: 'Remember 42'
    }
  ],
  coverage: {
    eligibleCount: 1,
    omittedCount: 0,
    firstItemId: 'saved',
    lastItemId: 'saved',
    inventoryDigest: 'digest'
  }
}

function seedOwner(db: Database.Database, sessionId: string): void {
  const owner = agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/test' },
    providerHandleChain: [link(0)]
  })
  db.prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)').run(
    sessionId,
    JSON.stringify(encodeAgentSessionRecord(owner))
  )
}

function delivery(
  sessionId: string,
  id: string,
  handoffId: string,
  targetId: string,
  outcome: ContextTransferDelivery['outcome']
): ContextTransferDelivery {
  return {
    kind: 'delivery',
    id,
    handoffId,
    sessionId,
    targetId,
    mode: 'inline',
    carrierInputId: `carrier-${id}`,
    preparedAt: 1,
    selection: selectRecoveryDelivery({
      id,
      capture,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Next' }] }
    }),
    writeStartedAt: 1,
    outcome
  }
}

/** One published owed target with `refused` known-before-write attempts retained on it. */
function seedRefusedAttempts(db: Database.Database, sessionId: string, refused: number) {
  seedOwner(db, sessionId)
  const handoff: ContextTransferRecord = {
    kind: 'handoff',
    id: 'H',
    handoffId: 'H',
    sessionId,
    sourceLink: link(0),
    sourceCursor: { epoch: 'e', sequence: 1 },
    contextFloor: null,
    trigger: 'codex-no-rollout',
    capturedAt: 1,
    capture
  }
  runJournalTransaction(db, () => {
    writeContextTransfer(db, handoff)
    writeContextTransfer(db, {
      kind: 'target',
      id: 'T',
      handoffId: 'H',
      sessionId,
      preparedAt: 1,
      fence: 1,
      acquisitionGeneration: 'G',
      sourceLinkId: 'L0',
      predecessorTargetId: null,
      targetLink: link(1),
      firstInputId: null
    })
    for (let i = 0; i < refused; i++) {
      writeContextTransfer(
        db,
        delivery(sessionId, `refused-${i}`, 'H', 'T', {
          kind: 'refused-before-write',
          at: 1,
          failureKind: 'carrier-refused'
        })
      )
    }
  })
}

describe('keyed transfer facts', () => {
  it.each([20, 200])(
    'plans every keyed read as an index search with %i refused attempts',
    async (refused) => {
      const db = await database()
      seedRefusedAttempts(db, 'chat', refused)
      const params: Record<keyof typeof CONTEXT_TRANSFER_KEYED_SQL, (string | number)[]> = {
        foreignFormat: ['chat'],
        any: ['chat'],
        byId: ['T'],
        newestTarget: ['chat'],
        closed: ['chat', 'H'],
        delivered: ['chat', 'T'],
        startedWithoutOutcome: ['chat', 'T'],
        startedUnknown: ['chat', 'T'],
        carriers: ['chat', 'carrier-refused-0'],
        closedByCommand: ['chat', 'clear'],
        newestClosure: ['chat'],
        handoffsAfter: ['chat', 0]
      }
      const args = new Map(Object.entries(params))
      for (const [name, sql] of Object.entries(CONTEXT_TRANSFER_KEYED_SQL)) {
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...(args.get(name) ?? []))
          .map((row) => String(row.detail))
        expect(plan.join(' | '), name).toMatch(/SEARCH/)
        expect(plan.join(' | '), name).not.toMatch(/\bSCAN\b/)
      }
    }
  )

  it('refuses a chat holding a row in another format, or bytes that are not its row', async () => {
    const db = await database()
    seedRefusedAttempts(db, 'foreign', 0)
    db.prepare(
      "INSERT INTO agent_session_context_transfers (id,session_id,handoff_id,kind,format,record_json) VALUES ('future','foreign','H','delivery',2,'{}')"
    ).run()
    expect(() => new ContextTransferFacts(db, 'foreign').currentTarget()).toThrow(
      /context transfer cannot be read|newer|read/i
    )
    const malformed = await database()
    seedRefusedAttempts(malformed, 'malformed', 0)
    malformed
      .prepare(
        "UPDATE agent_session_context_transfers SET record_json = '{\"broken' WHERE id = 'H'"
      )
      .run()
    expect(() => new ContextTransferFacts(malformed, 'malformed').handoff('H')).toThrow(
      /context transfer cannot be read|newer|read/i
    )
  })

  it('maps malformed JSON a lookup reaches without its index to the same refusal', async () => {
    const db = await database(false)
    seedRefusedAttempts(db, 'chat', 2)
    db.prepare(
      "INSERT INTO agent_session_context_transfers (id,session_id,handoff_id,kind,format,record_json) VALUES ('bad','chat','H','delivery',1,'{\"broken')"
    ).run()
    let thrown: unknown
    try {
      new ContextTransferFacts(db, 'chat').delivered('T')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toMatchObject({ code: 'ERR_SQLITE_ERROR' })
  })

  it.each([true, false])(
    'finds the same current target as the whole-chat rule across random edits (indexes %s)',
    async (indexed) => {
      const db = await database(indexed)
      let seed = 0x5eed
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
        return seed / 2_147_483_648
      }
      for (let sequence = 0; sequence < 40; sequence++) {
        const sessionId = `property-${sequence}`
        seedOwner(db, sessionId)
        const facts = new ContextTransferFacts(db, sessionId)
        for (let step = 0; step < 30; step++) {
          const id = `${sequence}-${step}`
          const current = facts.currentTarget()
          const choice = Math.floor(random() * 6)
          try {
            runJournalTransaction(db, () => {
              if (choice === 0 || (!current && choice < 4)) {
                writeContextTransfer(db, {
                  kind: 'handoff',
                  id: `H${id}`,
                  handoffId: `H${id}`,
                  sessionId,
                  sourceLink: link(0),
                  sourceCursor: { epoch: 'e', sequence: step },
                  contextFloor: null,
                  trigger: 'codex-no-rollout',
                  capturedAt: step,
                  capture,
                  ...(current && random() < 0.5 ? { supersedesHandoffId: current.handoffId } : {})
                })
                writeContextTransfer(db, {
                  kind: 'target',
                  id: `T${id}`,
                  handoffId: `H${id}`,
                  sessionId,
                  preparedAt: step,
                  fence: 1,
                  acquisitionGeneration: null,
                  sourceLinkId: 'L0',
                  predecessorTargetId: current && random() < 0.5 ? current.id : null,
                  targetLink: null,
                  firstInputId: null
                })
              } else if (choice === 1 && current) {
                writeContextTransfer(db, {
                  ...current,
                  id: `T${id}`,
                  predecessorTargetId: current.id,
                  targetLink: null,
                  acquisitionGeneration: null,
                  firstInputId: null
                })
              } else if (choice === 2 && current && !current.targetLink) {
                writeContextTransfer(db, {
                  ...current,
                  targetLink: link(step + 2),
                  acquisitionGeneration: `G${id}`
                })
              } else if (choice === 3 && current?.targetLink) {
                const outcomes: ContextTransferDelivery['outcome'][] = [
                  { kind: 'injected', at: step, requestId: 'r' },
                  { kind: 'refused-before-write', at: step, failureKind: 'carrier-refused' },
                  { kind: 'unknown', at: step, reason: 'lost' },
                  null
                ]
                writeContextTransfer(
                  db,
                  delivery(
                    sessionId,
                    `D${id}`,
                    current.handoffId,
                    current.id,
                    outcomes[Math.floor(random() * 4)] ?? null
                  )
                )
              } else if (choice === 4) {
                closeContextTransfers(db, sessionId, `clear-${id}`, 'context-clear', step)
              } else if (current) {
                closeContextTransfers(db, sessionId, `rewind-${id}`, 'rewind', step, `H${id}`)
                writeContextTransfer(db, {
                  kind: 'handoff',
                  id: `H${id}`,
                  handoffId: `H${id}`,
                  sessionId,
                  sourceLink: link(0),
                  sourceCursor: { epoch: 'e', sequence: step },
                  contextFloor: null,
                  trigger: 'context-edit',
                  capturedAt: step,
                  capture,
                  supersedesHandoffId: current.handoffId
                })
                writeContextTransfer(db, {
                  kind: 'target',
                  id: `T${id}`,
                  handoffId: `H${id}`,
                  sessionId,
                  preparedAt: step,
                  fence: 1,
                  acquisitionGeneration: null,
                  sourceLinkId: 'L0',
                  predecessorTargetId: null,
                  targetLink: null,
                  firstInputId: null
                })
              }
            })
          } catch {
            // The real validation refused this edit; the rule must agree on what remains.
          }
          expect(facts.currentTarget()?.id).toBe(
            currentContextTransferTarget(readContextTransfers(db, sessionId))?.id
          )
        }
      }
    }
  )
})
