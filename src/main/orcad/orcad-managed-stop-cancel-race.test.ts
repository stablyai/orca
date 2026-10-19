import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as StopDecision from './orcad-managed-stop-decision'

const decisions = vi.hoisted(() => ({ read: vi.fn<() => string | null>() }))
vi.mock('./orcad-managed-stop-decision', async (importOriginal) => ({
  ...(await importOriginal<typeof StopDecision>()),
  readOrcadManagedStopDecision: decisions.read
}))

import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { completeOrcadManagedStop } from './orcad-managed-stop-completion'
import { orcadManagedStopRequestPath } from './orcad-managed-stop-request'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('withdraws its own request when a cancel wins between the decision check and the write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orcad-stop-race-'))
  roots.push(root)
  const lock = acquireOrcadInstanceLock(root, { identity: () => 'uid-1000', startedAtMs: () => 5 })
  const { pid, startedAtMs, nonce } = lock.record
  const request = {
    schemaVersion: 1 as const,
    transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
    version: '1.0.0',
    runtimeId: 'runtime-1',
    instance: { pid, startedAtMs, nonce, lockPath: lock.path }
  }
  // The cancel lands after the first read, when there is no request file yet for it to remove.
  decisions.read.mockReturnValueOnce(null).mockReturnValue('canceled')

  const verdict = await completeOrcadManagedStop(request, {
    probeProcess: () => 'alive',
    startedAtMs: () => 5,
    sleep: async () => {},
    attempts: 1
  })

  expect(verdict).toBe('live')
  expect(existsSync(orcadManagedStopRequestPath(request.instance))).toBe(false)
})
