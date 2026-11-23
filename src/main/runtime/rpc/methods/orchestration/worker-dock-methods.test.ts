import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RpcContext } from '../../core'
import type { RpcCallerIdentity } from '../../callers/rpc-caller-identity'
import { ORCHESTRATION_WORKER_DOCK_METHODS } from './worker-dock-methods'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('refuses CLI and paired-device stop or acknowledgment as desktop owner intent', async () => {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const callers: (RpcCallerIdentity | undefined)[] = [
    undefined,
    { kind: 'local-cli' },
    { kind: 'paired-device', deviceId: 'paired-desktop' },
    { kind: 'paired-device', deviceId: 'paired-agent', agent: true }
  ]
  const params = {
    party: 'orca_session_id:11111111-1111-4111-8111-111111111111',
    dispatch: 'ctx_unknown',
    requestId: 'stop-request',
    settlements: [],
    acknowledged: true
  }
  for (const caller of callers) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only need the DB after the caller guard.
    const ctx = { runtime: { getOrchestrationDb: () => db }, caller } as RpcContext
    for (const method of ORCHESTRATION_WORKER_DOCK_METHODS) {
      if (
        method.name === 'orchestration.workerDockStop' ||
        method.name === 'orchestration.workerDockAcknowledge'
      ) {
        await expect(async () => method.handler(params, ctx)).rejects.toMatchObject({
          code: 'owner_required'
        })
      }
    }
  }
})
