import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import { importPairedServerItem } from './paired-server-ask-import'
import { flushPairedServerReturns } from './paired-server-ask-returns'
import type { PairedServerAsks } from './paired-server-asks-pull'

const SERVER: PairedServerAsks = {
  environmentId: 'env_s',
  serverName: 'Build Box',
  serverKey: 'fingerprint_s',
  pairing: 'fingerprint_a',
  wire: { session: 'session_1', installationId: 'install_a', name: "Alice's Mac" }
}

const Returned = z.object({ items: z.array(z.object({ messageId: z.string() })) })

describe('what this computer hands back to a paired server', () => {
  let dir: string
  let db: OrchestrationDb
  let pages: string[][]
  let answer: (page: number) => unknown
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-paired-server-returns-'))
    db = new OrchestrationDb(join(dir, 'computer.db'))
    pages = []
    answer = () => ({ acknowledgments: [], gone: [] })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the members the returns and import code read.
    runtime = {
      getOrchestrationDb: () => db,
      readMachineName: () => "Alice's Mac",
      bots: { list: () => [] },
      callOrchestrationWorkerServer: vi.fn(
        async (_environment: string, _method: string, params: unknown) => {
          pages.push(Returned.parse(params).items.map((item) => item.messageId))
          return answer(pages.length)
        }
      )
    } as unknown as OrcaRuntimeService
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const open = (conversationId: string, environmentId: string) =>
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, 'peer', ?, ?)`
      )
      .run(conversationId, SERVER.pairing, environmentId)

  const queue = (conversationId: string, messageId: string) =>
    db.enqueueFederationRelay({
      dispatchId: conversationId,
      direction: 'to_home',
      kind: 'peer_mail',
      messageId,
      payload: '{}'
    })

  it("opens no conversation for an ask naming a dispatch, so that dispatch's reports never go back", async () => {
    const dispatchId = 'ctx_0000000000d1'
    queue(dispatchId, 'msg_worker_report')

    await importPairedServerItem(runtime, db, SERVER, {
      conversationId: dispatchId,
      messageId: 'm_dispatch',
      kind: 'client_ask',
      payload: JSON.stringify({
        to: 'bot:docs',
        senderLabel: 'Ranger',
        subject: 'Hi',
        type: 'status',
        rootSession: 'orca_session_id:asker'
      })
    })
    await flushPairedServerReturns(runtime, SERVER)

    expect(db.getPeerMailConversation(dispatchId)).toBeFalsy()
    expect(pages).toEqual([])
    expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
  })

  it('takes acknowledgments only for what it handed back: never past the page, never another conversation', async () => {
    const sentHere = 'peerconv_0000000000b1'
    const otherServer = 'peerconv_0000000000b2'
    open(sentHere, SERVER.environmentId)
    open(otherServer, 'env_other')
    // One more than a page, so the last waits for the next one.
    for (let index = 0; index < 51; index += 1) {
      queue(sentHere, `msg_return_${index}`)
    }
    queue(otherServer, 'msg_other_server')
    // The first answer claims far more than it was sent, and another server's conversation.
    answer = (page) =>
      page === 1
        ? {
            acknowledgments: [
              { conversationId: sentHere, throughSequence: 1_000_000 },
              { conversationId: otherServer, throughSequence: 1_000_000 }
            ],
            gone: [otherServer]
          }
        : { acknowledgments: [], gone: [] }

    await flushPairedServerReturns(runtime, SERVER)

    expect(pages.map((page) => page.length)).toEqual([50, 1])
    expect(pages[1]).toEqual(['msg_return_50'])
    expect(db.listPendingFederationRelay(sentHere, 'to_home')).toHaveLength(1)
    expect(db.listPendingFederationRelay(otherServer, 'to_home')).toHaveLength(1)
  })
})
