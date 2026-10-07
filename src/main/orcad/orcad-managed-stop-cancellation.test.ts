import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_CANCEL_MANAGED_STOP_FLAG,
  OrcadManagedStopCancellationSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { orcadManagedStopRequestPath } from './orcad-managed-stop-request'
import { cancelOrcadManagedStop } from './orcad-managed-stop-cancellation'
import {
  claimOrcadManagedStopDecision,
  readOrcadManagedStopDecision
} from './orcad-managed-stop-decision'
import { completeOrcadManagedStop } from './orcad-managed-stop-completion'
import { runOrcadManagedStopCancelCommand } from './orcad-managed-stop-command'
import { installOrcadStopRequestListeners } from './orcad-stop-request-listener'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function running(): OrcadManagedStopRequest {
  const root = mkdtempSync(join(tmpdir(), 'orcad-stop-cancel-'))
  roots.push(root)
  const lock = acquireOrcadInstanceLock(root, { identity: () => 'uid-1000', startedAtMs: () => 5 })
  const { pid, startedAtMs, nonce } = lock.record
  return {
    schemaVersion: 1,
    transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
    version: '1.0.0',
    runtimeId: 'runtime-1',
    instance: { pid, startedAtMs, nonce, lockPath: lock.path }
  }
}

describe('cancelling a managed stop', () => {
  it('lets exactly one side decide a transaction', () => {
    const request = running()
    expect(claimOrcadManagedStopDecision(request, 'canceled')).toBe('canceled')
    expect(claimOrcadManagedStopDecision(request, 'dispatched')).toBe('canceled')
    expect(readOrcadManagedStopDecision(request)).toBe('canceled')
  })

  it('withdraws a request orcad has not acted on, and removes its file', () => {
    const request = running()
    writeFileSync(orcadManagedStopRequestPath(request.instance), JSON.stringify(request))
    expect(cancelOrcadManagedStop(request)).toBe('canceled')
    expect(existsSync(orcadManagedStopRequestPath(request.instance))).toBe(false)
  })

  it('reports dispatched once orcad acted first, and leaves its request in place', () => {
    const request = running()
    writeFileSync(orcadManagedStopRequestPath(request.instance), JSON.stringify(request))
    expect(claimOrcadManagedStopDecision(request, 'dispatched')).toBe('dispatched')
    expect(cancelOrcadManagedStop(request)).toBe('dispatched')
    expect(existsSync(orcadManagedStopRequestPath(request.instance))).toBe(true)
  })

  it('never removes another transaction pending for the same instance', () => {
    const request = running()
    const other = { ...request, transactionId: '5a7e1f0c-3b2d-4e6f-9a8b-7c6d5e4f3a2b' }
    writeFileSync(orcadManagedStopRequestPath(request.instance), JSON.stringify(other))
    expect(cancelOrcadManagedStop(request)).toBe('canceled')
    expect(existsSync(orcadManagedStopRequestPath(request.instance))).toBe(true)
  })

  it('does not reissue a cancelled transaction while orcad keeps running', async () => {
    const request = running()
    cancelOrcadManagedStop(request)
    expect(
      await completeOrcadManagedStop(request, {
        probeProcess: () => 'alive',
        startedAtMs: () => 5,
        sleep: async () => {}
      })
    ).toBe('live')
    expect(existsSync(orcadManagedStopRequestPath(request.instance))).toBe(false)
  })

  it('keeps orcad running when its listener meets a cancelled request', async () => {
    const request = running()
    cancelOrcadManagedStop(request)
    writeFileSync(orcadManagedStopRequestPath(request.instance), JSON.stringify(request))
    const onRequest = vi.fn()
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = mkdtempSync(join(tmpdir(), 'orcad-stop-cancel-slot-'))
    roots.push(root)
    const listener = installOrcadStopRequestListeners(onRequest, {
      installRoot: root,
      managedStop: {
        version: request.version,
        runtimeId: request.runtimeId,
        instance: request.instance
      },
      pollIntervalMs: 10
    })
    await vi.waitFor(() => expect(report).toHaveBeenCalled())
    listener.close()
    expect(onRequest).not.toHaveBeenCalled()
    expect(String(report.mock.calls[0]?.[1])).toContain('orcad_managed_stop_canceled')
    // Left in place, it would make every later transaction's completion answer unverifiable.
    expect(existsSync(orcadManagedStopRequestPath(request.instance))).toBe(false)
  })

  it('prints one cancellation line through the command', () => {
    const request = running()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const cancellation = runOrcadManagedStopCancelCommand([
      ORCAD_CANCEL_MANAGED_STOP_FLAG,
      JSON.stringify(request)
    ])
    expect(cancellation.outcome).toBe('canceled')
    expect(
      OrcadManagedStopCancellationSchema.parse(JSON.parse(String(write.mock.calls[0]?.[0])))
    ).toEqual(cancellation)
  })
})
