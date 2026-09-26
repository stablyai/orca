import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerReportOutbox } from '../../shared/worker-report-outbox'
import { callWithWorkerReportCustody } from './worker-report-custody'
import { RuntimeClientError } from './types'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-report-'))
  roots.push(root)
  return { root, store: new WorkerReportOutbox(root) }
}
const params = {
  from: 'term-original',
  type: 'worker_done',
  subject: 'Failed',
  payload: JSON.stringify({
    taskId: 'task-original',
    dispatchId: 'dispatch-original',
    outcome: 'failed'
  })
}
const options = {
  orchestrationCapability: 'dcap-original',
  orchestrationRequestId: 'operation-original'
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('CLI worker report custody', () => {
  it.each([
    'unauthorized',
    'forbidden',
    'orchestration_migration_required',
    'incompatible_runtime'
  ])('retains a report after a pre-effect %s refusal', async (code) => {
    const { root, store } = fixture()
    await expect(
      callWithWorkerReportCustody({
        userDataPath: root,
        pairing: null,
        params,
        options,
        send: async () => {
          throw new RuntimeClientError(code, 'admission refused')
        }
      })
    ).rejects.toMatchObject({ code: 'worker_report_pending' })
    expect(await store.pending()).toHaveLength(1)
  })

  it('persists exact authority and remote credentials before the first transport call', async () => {
    const { root, store } = fixture()
    const pairing = {
      v: 2 as const,
      endpoint: 'ws://original:123',
      deviceToken: 'device-original',
      publicKeyB64: 'key-original'
    }
    const send = vi.fn(async (envelope) => {
      const records = await store.pending()
      expect(records).toHaveLength(1)
      expect(records[0]?.input).toMatchObject({
        requestId: options.orchestrationRequestId,
        params,
        pairing,
        envelope: options
      })
      expect(envelope.orchestrationRequestId).toBe(options.orchestrationRequestId)
      throw new RuntimeClientError('runtime_unavailable', 'offline')
    })
    await expect(
      callWithWorkerReportCustody({ userDataPath: root, pairing, params, options, send })
    ).rejects.toMatchObject({
      code: 'worker_report_pending',
      data: { custody: 'local_outbox', orchestrationRequestId: 'operation-original' }
    })
    expect(send).toHaveBeenCalledOnce()
    expect(await new WorkerReportOutbox(root).pending()).toHaveLength(1)
  })

  it.each([
    'dispatch_capability_revoked',
    'run_destination_unsupported',
    'run_destination_unresolved',
    'dispatch_capability_invalid'
  ])('stops retrying an explicit %s refusal and removes secrets', async (code) => {
    const { root, store } = fixture()
    await expect(
      callWithWorkerReportCustody({
        userDataPath: root,
        pairing: null,
        params,
        options,
        send: async () => {
          throw new RuntimeClientError(code, 'refused')
        }
      })
    ).rejects.toMatchObject({ code })
    expect(await store.pending()).toEqual([])
    const contents = readFileSync(join(store.directory, readdirSync(store.directory)[0]!), 'utf8')
    expect(contents).toContain(code)
    expect(contents).not.toContain('dcap-original')
  })

  it('keeps custody when an older runtime returns an unverified success', async () => {
    const { root, store } = fixture()
    await callWithWorkerReportCustody({
      userDataPath: root,
      pairing: null,
      params,
      options,
      send: async () => ({
        id: 'rpc',
        ok: true,
        _meta: { runtimeId: 'old' },
        result: { message: { id: 'accepted-only' } }
      })
    })
    expect(await store.pending()).toHaveLength(1)
  })
})
