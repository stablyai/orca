import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { commitRuntimePtySpawn } from './spawn-commit'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const ADOPTED_PTY_ID = 'pty-adopted-owner'

function makeAdoptedCtx(runtime: OrcaRuntimeService) {
  const deps = { runtime, store: undefined, options: {} } as unknown as PtyRuntimeControllerDeps
  const args = { cols: 120, rows: 40, worktreeId: 'wt-adopted' } as unknown as RuntimePtySpawnArgs
  const ctx = createRuntimePtySpawnState(deps, args)
  ctx.result = {
    id: ADOPTED_PTY_ID,
    incarnationId: 'incarnation-adopted',
    isReattach: true,
    agentSessionEnsure: {
      disposition: 'adopted',
      owner: {
        claim: { kind: 'terminal' },
        generation: 'g1',
        phase: 'live',
        ptyId: ADOPTED_PTY_ID,
        surface: {
          worktreeId: 'wt-adopted',
          tabId: 'tab-adopted',
          leafId: '44444444-4444-4444-8444-444444444444',
          terminalHandle: 'term_adopted'
        }
      }
    }
  } as unknown as typeof ctx.result
  return ctx
}

describe('commitAdoptedAgentSessionOwner', () => {
  // Why: this branch returns before the normal settle site, so an admission token whose
  // candidate the commit cannot prepare (stale/duplicate/different-id ownership) would stay
  // pending for that PTY id forever and hold back its generation reset.
  it('settles a pending observation admission the commit could not prepare', async () => {
    const runtime = new OrcaRuntimeService()
    const ctx = makeAdoptedCtx(runtime)
    // The token still owns the pre-reply id, so preparePtyObservationAdmission returns null.
    ctx.observationAdmissionToken = runtime.beginPtyObservationAdmission('pty-requested-id')
    const internals = runtime as unknown as {
      pendingPtyObservationAdmissionsByToken: Map<string, unknown>
      pendingPtyObservationAdmissionTokensByPtyId: Map<string, string>
    }
    expect(internals.pendingPtyObservationAdmissionsByToken.size).toBe(1)

    await commitRuntimePtySpawn(ctx)

    expect(internals.pendingPtyObservationAdmissionsByToken.size).toBe(0)
    expect(internals.pendingPtyObservationAdmissionTokensByPtyId.size).toBe(0)
    expect(ctx.observationAdmissionToken).toBeNull()
  })

  it('keeps promoting the adopted owner through registerPty', async () => {
    const runtime = new OrcaRuntimeService()
    const registerPty = vi.spyOn(runtime, 'registerPty')
    const ctx = makeAdoptedCtx(runtime)
    ctx.observationAdmissionToken = runtime.beginPtyObservationAdmission(ADOPTED_PTY_ID)

    const reply = await commitRuntimePtySpawn(ctx)

    expect(reply).toMatchObject({ id: ADOPTED_PTY_ID, incarnationId: 'incarnation-adopted' })
    expect(registerPty).toHaveBeenCalledWith(
      ADOPTED_PTY_ID,
      'wt-adopted',
      null,
      expect.objectContaining({ terminalHandle: 'term_adopted' }),
      undefined,
      expect.objectContaining({ ptyId: ADOPTED_PTY_ID })
    )
    const internals = runtime as unknown as {
      pendingPtyObservationAdmissionsByToken: Map<string, unknown>
    }
    expect(internals.pendingPtyObservationAdmissionsByToken.size).toBe(0)
  })
})
