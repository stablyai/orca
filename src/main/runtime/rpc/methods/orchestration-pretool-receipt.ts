import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveWorkerMutationVerdict } from '../../orchestration/control-plane/worker-mutation-verdict'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString } from '../schemas'

/** Retired public bridge. A supervised worker can call any public RPC itself,
 * so no public request may mint proof that a provider actually reached its
 * synchronous pre-tool boundary. The live hook server records that event in
 * the same runtime transaction instead. This method is intentionally not in
 * the registered method set; the throw protects accidental re-registration. */
export const PRETOOL_RECEIPT_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.pretoolReceipt',
  params: z.object({}),
  handler: () => {
    throw new OrchestrationError(
      'command_retired',
      'PreTool evidence is recorded only by the authenticated synchronous hook transaction.'
    )
  }
})

/** The question the PreTool policy cannot answer for itself.
 *
 *  Orca decides no policy here and adds no allowlist. It reports one fact it
 *  alone owns — whether the workspace this attested session occupies is under
 *  someone else's validation lease right now — so the single existing policy can
 *  deny a tool call that would edit a tree a gate is running on.
 *
 *  This is the path the dispatcher fence cannot reach. A worker that is already
 *  running does not mutate through `files.write` or `terminal.send`; it uses its
 *  own Bash and Edit inside a shell that predates the lease, which is exactly
 *  how two certification workers committed to the Package B branch mid-gate.
 *
 *  Read-only by construction: it writes nothing, so asking can never manufacture
 *  the acceptance receipt that `pretool_acceptance` requires.
 */
export const MUTATION_VERDICT_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.mutationVerdict',
  params: z.object({ tool: OptionalString, from: OptionalString }),
  handler: (
    _params,
    { runtime, orchestrationCompatibilityEvidence, orchestrationCompatibilityCallerAuthority }
  ) => {
    // Attested identity only, and ONE placement record for it. A pane key a
    // caller could state is a pane key it could borrow; resolving the terminal,
    // the workspace and the exact provider session together from the runtime's
    // own record is what makes the answer about this session rather than about
    // whoever occupied this pane last.
    const caller =
      orchestrationCompatibilityCallerAuthority ??
      runtime.verifyOrchestrationCompatibilityCaller(orchestrationCompatibilityEvidence)
    if (!caller) {
      throw new OrchestrationError(
        'mutation_verdict_unattested',
        'A mutation verdict requires the exact attested provider process asking the question.'
      )
    }
    const placement = runtime.resolveAttestedPanePlacement(caller.paneKey)
    if (
      !placement ||
      placement.terminalHandle !== caller.terminalHandle ||
      placement.processIncarnation !== caller.processIncarnation
    ) {
      throw new OrchestrationError(
        'mutation_verdict_unattested',
        'The attested provider process no longer occupies its recorded Orca pane.'
      )
    }
    return {
      verdict: resolveWorkerMutationVerdict({
        db: runtime.getOrchestrationDb(),
        session: {
          terminalHandle: caller.terminalHandle,
          paneKey: caller.paneKey,
          processIncarnation: caller.processIncarnation,
          worktreeId: placement.worktreeId
        },
        nowMs: Date.now()
      })
    }
  }
})
