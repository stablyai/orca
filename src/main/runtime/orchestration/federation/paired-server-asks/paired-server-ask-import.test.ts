import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import { importPairedServerItem } from './paired-server-ask-import'
import { flushPairedServerReturns } from './paired-server-ask-returns'
import type { PairedServerAsks } from './paired-server-asks-pull'

describe('importPairedServerItem', () => {
  let dir: string | null = null
  let db: OrchestrationDb | null = null

  afterEach(() => {
    db?.close()
    db = null
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = null
    }
  })

  it('drops pulled items with non-peerconv conversation IDs so worker dispatches are never exposed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-paired-server-ask-import-'))
    db = new OrchestrationDb(join(dir, 'computer.db'))
    const runtime = new OrcaRuntimeService(null)
    vi.spyOn(runtime, 'readMachineName').mockReturnValue("Alice's Mac")
    vi.spyOn(runtime.bots, 'list').mockReturnValue([])
    const callServer = vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      acknowledgments: [],
      gone: []
    })
    runtime.setOrchestrationDb(db)

    const workerDispatchId = 'ctx_112233445566'
    db.enqueueFederationRelay({
      dispatchId: workerDispatchId,
      direction: 'to_home',
      kind: 'worker_done',
      messageId: 'msg_worker_report',
      payload: JSON.stringify({ body: 'sensitive worker report' })
    })

    const asks: PairedServerAsks = {
      environmentId: 'env_s',
      serverName: 'Build Box',
      serverKey: 'fingerprint_s',
      pairing: 'fingerprint_a',
      wire: {
        session: 'session_1',
        installationId: 'install_a',
        name: "Alice's Mac"
      }
    }

    const imported = await importPairedServerItem(runtime, db, asks, {
      conversationId: workerDispatchId,
      messageId: 'msg_probe_0001',
      kind: 'client_ask',
      payload: JSON.stringify({
        to: 'bot:docs',
        senderLabel: 'Ranger',
        subject: 'Probe',
        type: 'question',
        rootSession: 'orca_session_id:ranger'
      })
    })
    await flushPairedServerReturns(runtime, asks)

    expect(imported).toEqual({ card: false })
    expect(db.getPeerMailConversation(workerDispatchId)).toBeUndefined()
    expect(callServer).not.toHaveBeenCalled()
    expect(db.listPendingFederationRelay(workerDispatchId, 'to_home', 10)).toMatchObject([
      { dispatch_id: workerDispatchId, message_id: 'msg_worker_report' }
    ])
  })
})
