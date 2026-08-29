import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

describe('orchestration Run remint authority', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => harness.cleanup())

  it('preserves a same-process remint when the agent hook still reports the old pane', async () => {
    const { db, runtime } = harness.setup(false)
    const oldPane = 'tab_old:11111111-1111-4111-8111-111111111111'
    const remintedPane = 'tab_new:11111111-1111-4111-8111-111111111111'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_old' ? oldPane : remintedPane
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
      runtimeId: 'runtime_test',
      terminalHandle: handle,
      ptyId: 'pty_coord',
      worktreeId: 'folder:workspace',
      processIncarnation: 'pty_coord:incarnation-1',
      paneKey: handle === 'term_old' ? oldPane : remintedPane,
      launchTokenHash: 'current-launch-hash',
      hostScope: { kind: 'local', hostId: 'local' }
    }))
    const created = db.createRun({
      objective: 'Survive stale hook evidence',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: oldPane,
      coordinatorProcessIncarnation: 'pty_coord:incarnation-1',
      coordinatorHostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    const ctx: RpcContext = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_reminted',
        paneKey: remintedPane,
        launchToken: 'current-launch'
      }
    }
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (_evidence, options) =>
        options?.currentRuntimeLaunchSufficient
          ? {
              terminalHandle: 'term_reminted',
              paneKey: remintedPane,
              processIncarnation: 'pty_coord:incarnation-1',
              launchTokenHash: 'current-launch-hash',
              hostScope: { kind: 'local', hostId: 'local' },
              terminalProvenance: 'current_runtime'
            }
          : null
    )

    const rebound = (await harness.call(
      'orchestration.runUse',
      { id: created.id, from: 'term_reminted' },
      ctx
    )) as { run: { coordinator_handle: string; consumer_generation: number } }

    expect(rebound.run).toMatchObject({
      coordinator_handle: 'term_reminted',
      consumer_generation: created.consumer_generation
    })
  })
})
