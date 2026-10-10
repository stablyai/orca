import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerReportOutbox } from '../../shared/worker-report-outbox'
import { callWithWorkerReportCustody, isWorkerReport } from './worker-report-custody'
import { RuntimeClientError } from './types'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-report-'))
  roots.push(root)
  return { root, store: new WorkerReportOutbox(root) }
}
const params = {
  from: 'term-original',
  type: 'worker_done' as const,
  subject: 'Failed',
  payload: JSON.stringify({
    taskId: 'task-original',
    dispatchId: 'dispatch-original',
    outcome: 'failed'
  })
}
const options = {
  orchestrationCompatibilityEvidence: {
    terminalHandle: 'term-original',
    paneKey: 'pane-original',
    launchToken: 'launch-original'
  },
  orchestrationRequestId: 'operation-original'
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('CLI worker report custody', () => {
  it('keeps structured session callers on their existing delivery path', () => {
    expect(isWorkerReport('orchestration.send', { ...params, from: undefined })).toBe(false)
    expect(
      isWorkerReport('orchestration.send', {
        ...params,
        from: 'orca_session_id:12345678-1234-4234-8234-123456789012'
      })
    ).toBe(false)
    expect(isWorkerReport('orchestration.send', params)).toBe(true)
  })

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
        params,
        options,
        send: async () => {
          throw new RuntimeClientError(code, 'admission refused')
        }
      })
    ).rejects.toMatchObject({ code: 'worker_report_pending' })
    expect(await store.pending()).toHaveLength(1)
  })

  it('persists exact terminal evidence before the first transport call', async () => {
    const { root, store } = fixture()
    const send = vi.fn(async (envelope) => {
      const records = await store.pending()
      expect(records).toHaveLength(1)
      expect(records[0]?.input).toMatchObject({
        requestId: options.orchestrationRequestId,
        params,
        envelope: options
      })
      expect(envelope.orchestrationRequestId).toBe(options.orchestrationRequestId)
      throw new RuntimeClientError('runtime_unavailable', 'offline')
    })
    await expect(
      callWithWorkerReportCustody({ userDataPath: root, params, options, send })
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
  const accepted = {
    id: 'rpc',
    ok: true as const,
    _meta: { runtimeId: 'healthy' },
    result: { lifecycle: { action: 'settled', outcome: 'succeeded' } }
  }

  it.each(['oversized', 'full', 'not-a-directory'])(
    'preserves healthy completion delivery when storage is %s',
    async (failure) => {
      const { root, store } = fixture()
      if (failure === 'full') {
        mkdirSync(store.directory)
        for (let index = 0; index < 256; index++) {
          writeFileSync(join(store.directory, `${index}.tmp`), '')
        }
      } else if (failure === 'not-a-directory') {
        writeFileSync(store.directory, '')
      }
      const send = vi.fn(async () => accepted)
      await expect(
        callWithWorkerReportCustody({
          userDataPath: root,
          params: failure === 'oversized' ? { ...params, body: 'x'.repeat(256 * 1024) } : params,
          options,
          send
        })
      ).resolves.toEqual(accepted)
      expect(send).toHaveBeenCalledOnce()
      expect(send.mock.calls[0]).toEqual([
        expect.objectContaining({ orchestrationRequestId: options.orchestrationRequestId })
      ])
    }
  )

  it('does not claim durable recovery when neither storage nor delivery succeeded', async () => {
    const { root, store } = fixture()
    writeFileSync(store.directory, '')
    const send = vi.fn(async () => {
      throw new RuntimeClientError('runtime_unavailable', 'offline')
    })
    await expect(
      callWithWorkerReportCustody({ userDataPath: root, params, options, send })
    ).rejects.toMatchObject({
      code: 'worker_report_not_saved',
      data: { custody: 'none', orchestrationRequestId: options.orchestrationRequestId }
    })
    expect(send).toHaveBeenCalledOnce()
  })

  it('keeps authoritative success when acknowledged report cleanup fails', async () => {
    const { root, store } = fixture()
    vi.spyOn(WorkerReportOutbox.prototype, 'settle').mockRejectedValueOnce(
      new Error('disk unavailable')
    )
    await expect(
      callWithWorkerReportCustody({
        userDataPath: root,
        params,
        options,
        send: async () => accepted
      })
    ).resolves.toEqual(accepted)
    expect(await store.pending()).toHaveLength(1)
  })

  it('keeps the original permanent refusal when rejection cleanup fails', async () => {
    const { root } = fixture()
    vi.spyOn(WorkerReportOutbox.prototype, 'settle').mockRejectedValueOnce(
      new Error('disk unavailable')
    )
    await expect(
      callWithWorkerReportCustody({
        userDataPath: root,
        params,
        options,
        send: async () => {
          throw new RuntimeClientError('dispatch_capability_revoked', 'revoked')
        }
      })
    ).rejects.toMatchObject({ code: 'dispatch_capability_revoked' })
  })

  it('refuses changed contents under a saved mutation ID before transport', async () => {
    const { root, store } = fixture()
    await store.enqueue({
      requestId: options.orchestrationRequestId,
      params,
      envelope: { ...options, orchestrationContractVersion: 1 }
    })
    const send = vi.fn(async () => accepted)
    await expect(
      callWithWorkerReportCustody({
        userDataPath: root,
        params: { ...params, body: 'different' },
        options,
        send
      })
    ).rejects.toThrow('different input')
    expect(send).not.toHaveBeenCalled()
  })
})
