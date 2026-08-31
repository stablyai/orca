import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NO_GITHUB_AUTHORITY_POLICY,
  NO_GITHUB_AUTHORITY_POLICY_DIGEST,
  createWorkerAuthorityIsolationAttestation
} from '../../../shared/worker-authority-policy'
import { WORKER_AUTHORITY_IMAGE } from '../../providers/worker-authority-isolation'
import { OrchestrationDb } from './db'

describe('worker authority attestation persistence', () => {
  const roots: string[] = []
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records the runtime attestation once and retains it across restart', () => {
    const root = mkdtempSync('/private/tmp/orca-authority-db-')
    roots.push(root)
    const dbPath = join(root, 'orchestration.sqlite')
    db = new OrchestrationDb(dbPath)
    const task = db.createTask({ spec: 'isolated worker' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      runtimeEpoch: 'runtime-1',
      startOptions: { authorityPolicy: { policy: NO_GITHUB_AUTHORITY_POLICY } }
    })
    const request = {
      schemaVersion: 'worker_authority_launch/1',
      policy: NO_GITHUB_AUTHORITY_POLICY,
      policyDigest: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
      capabilityRef: `sha256:${'1'.repeat(64)}`,
      dispatchId: started.dispatch.id,
      worktreeId: 'worktree-1',
      setupPolicy: 'skip',
      imageDigest: WORKER_AUTHORITY_IMAGE,
      lifecycleDirectory: '/private/tmp/not-exposed',
      lifecycleBinding: `sha256:${'2'.repeat(64)}`
    } as const
    const attestation = createWorkerAuthorityIsolationAttestation({
      request,
      runtimeId: 'runtime-1',
      runId: task.run_id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      agentId: 'codex',
      processIncarnation: 'runtime-1:pty-1:1'
    })

    db.recordWorkerAuthorityAttestation(started.dispatch.id, attestation)
    expect(() => db!.recordWorkerAuthorityAttestation(started.dispatch.id, attestation)).toThrow(
      'already has an authority attestation'
    )
    db.close()
    db = new OrchestrationDb(dbPath)

    expect(JSON.parse(db.getWorkerDispatch(started.dispatch.id)!.start_options)).toMatchObject({
      authorityIsolation: attestation
    })
  })
})
