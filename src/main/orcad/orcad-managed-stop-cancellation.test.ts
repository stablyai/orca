import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WindowsAcl from '../../shared/secure-storage/secure-path-windows-acl'
import type { OrcadManagedStopRequest } from '../../shared/orcad-stop-request'

import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { orcadManagedStopRequestPath } from './orcad-managed-stop-request'
import { cancelOrcadManagedStop } from './orcad-managed-stop-cancellation'
import { claimOrcadManagedStopDecision } from './orcad-managed-stop-decision'

const hardening = vi.hoisted(() => ({ pending: new Set<Promise<void>>() }))

vi.mock('../../shared/secure-storage/secure-path-windows-acl', async (importOriginal) => {
  const acl = await importOriginal<typeof WindowsAcl>()
  return {
    ...acl,
    restrictWindowsDirectory: (dirPath: string): Promise<boolean> => {
      const restricted = acl.restrictWindowsDirectory(dirPath)
      const pending = restricted.then(() => undefined)
      hardening.pending.add(pending)
      void pending.then(() => hardening.pending.delete(pending))
      return restricted
    }
  }
})

const roots: string[] = []
afterEach(async () => {
  // ACL updates must finish before their temporary directories disappear.
  await Promise.all(hardening.pending)
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
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
})
