import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import './orca-runtime-test-lifecycle.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'

describe('startup worker recovery in a profile that never used orchestration', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not create the orchestration database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-no-orchestration-'))
    dirs.push(dir)
    const dbPath = join(dir, 'orchestration.db')
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    // A profile whose userData holds no orchestration database.
    class FreshProfileRuntime extends OrcaRuntimeService {
      protected override orchestrationDbPath(): string {
        return dbPath
      }
    }
    const runtime = new FreshProfileRuntime(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow: vi.fn() }),
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )

    await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toEqual({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    // Release reconciliation runs after the pass returns; shutdown drains it.
    await runtime.stopLegacyWorkerTerminalRecovery()

    expect(existsSync(dbPath)).toBe(false)
    expect(runtime.getExistingOrchestrationDb()).toBeNull()
  })
})
