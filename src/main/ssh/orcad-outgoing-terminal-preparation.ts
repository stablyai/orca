import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import {
  OrcadOutgoingPreparationStore,
  parseOrcadOutgoingPreparation
} from './orcad-outgoing-preparation-store'
import {
  OrcadOutgoingCaptureStore,
  parseOrcadOutgoingSourceBinding
} from './orcad-outgoing-capture-store'
import { withOutgoingOrcadAuthority } from './orcad-outgoing-authority'
import { prepareOutgoingOrcadSource } from './orcad-outgoing-source-preparation'
import { captureOutgoingOrcadSource } from './orcad-outgoing-source-capture'
import { publishOutgoingOrcadCapture } from './orcad-outgoing-capture-publication'
import { createOutgoingOrcadPreparation } from './orcad-outgoing-preparation-creation'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'

/** Resume saved intent without minting credentials or accepting a caller-supplied source route. */
export async function recoverOutgoingOrcadPreparation(
  userDataPath: string,
  args: {
    identity: PtyOwnershipTransferWireIdentity
    runtime: Parameters<typeof captureOutgoingOrcadSource>[0]['runtime']
    signal: AbortSignal
  }
) {
  if (!isPtyOwnershipTransferMutationEnabled()) {
    throw new Error('pty_ownership_transfer_mutation_disabled')
  }
  args.signal.throwIfAborted()
  const saved = new OrcadOutgoingPreparationStore(userDataPath).read(args.identity)
  if (!saved) {
    throw new Error('orcad_outgoing_preparation_missing')
  }
  return prepareOutgoingOrcadTerminal(userDataPath, {
    preparation: saved,
    ptyId: toAppSshPtyId(saved.sourceSshTargetId, saved.identity.terminalId),
    runtime: args.runtime,
    signal: args.signal,
    requireSavedPreparation: true
  })
}

export async function prepareOutgoingOrcadTerminalFromProvider(
  userDataPath: string,
  args: Parameters<typeof createOutgoingOrcadPreparation>[1] & {
    runtime: Parameters<typeof captureOutgoingOrcadSource>[0]['runtime']
  }
) {
  const preparation = await createOutgoingOrcadPreparation(userDataPath, args)
  return prepareOutgoingOrcadTerminal(userDataPath, {
    preparation,
    ptyId: args.ptyId,
    runtime: args.runtime,
    signal: args.signal,
    assertSurface: args.assertSurface
  })
}

type OutgoingTerminalPreparation = {
  preparation: unknown
  ptyId: string
  runtime: Parameters<typeof captureOutgoingOrcadSource>[0]['runtime']
  signal: AbortSignal
  requireSavedPreparation?: boolean
  assertSurface?: () => void
}

/** Publishes one captured terminal; catalog cutover and source retirement are separate operations. */
export async function prepareOutgoingOrcadTerminal(
  userDataPath: string,
  args: OutgoingTerminalPreparation
) {
  const attempt = outgoingTerminalPreparationAttempt(userDataPath, args)
  return withOutgoingOrcadAuthority(
    userDataPath,
    {
      binding: attempt.binding,
      signal: args.signal,
      assertEvidence: attempt.assertEvidence
    },
    attempt.run
  )
}

/** Caller already holds target/environment lifecycle locks and pins the destination pairing. */
export async function prepareOutgoingOrcadTerminalUnderAuthority(
  userDataPath: string,
  args: OutgoingTerminalPreparation,
  authority: { pairingCode: string; assertAuthority: () => void }
) {
  return outgoingTerminalPreparationAttempt(userDataPath, args).run(authority)
}

function outgoingTerminalPreparationAttempt(
  userDataPath: string,
  args: OutgoingTerminalPreparation
) {
  const intent = parseOrcadOutgoingPreparation(args.preparation)
  const binding = parseOrcadOutgoingSourceBinding(intent)
  const preparations = new OrcadOutgoingPreparationStore(userDataPath)
  const captures = new OrcadOutgoingCaptureStore(userDataPath)
  let preparationSaved = args.requireSavedPreparation === true
  const assertEvidence = () => {
    args.assertSurface?.()
    const saved = preparations.read(intent.identity)
    const capture = captures.read(intent.identity)
    if (
      (preparationSaved && !saved) ||
      (saved && serializeOrcadMigrationValue(saved) !== serializeOrcadMigrationValue(intent)) ||
      (capture &&
        serializeOrcadMigrationValue(parseOrcadOutgoingSourceBinding(capture)) !==
          serializeOrcadMigrationValue(binding))
    ) {
      throw new Error('orcad_outgoing_preparation_evidence_changed')
    }
  }
  return {
    binding,
    assertEvidence,
    async run(authority: { pairingCode: string; assertAuthority: () => void }) {
      const { pairingCode } = authority
      const assertAuthority = () => {
        args.signal.throwIfAborted()
        if (!isPtyOwnershipTransferMutationEnabled()) {
          throw new Error('pty_ownership_transfer_mutation_disabled')
        }
        authority.assertAuthority()
        assertEvidence()
      }
      assertAuthority()
      if (!captures.read(intent.identity)) {
        await prepareOutgoingOrcadSource({
          store: preparations,
          preparation: intent,
          ptyId: args.ptyId,
          signal: args.signal,
          assertAuthority,
          recoverDurability: args.requireSavedPreparation === true
        })
        preparationSaved = true
        assertAuthority()
        await captureOutgoingOrcadSource({
          store: captures,
          destination: binding,
          identity: intent.identity,
          ptyId: args.ptyId,
          runtime: args.runtime,
          signal: args.signal,
          assertAuthority
        })
        assertAuthority()
      }
      return publishOutgoingOrcadCapture({
        store: captures,
        identity: intent.identity,
        destinationEnvironmentId: intent.destinationEnvironmentId,
        sourceSshTargetId: intent.sourceSshTargetId,
        sourceSshTargetGeneration: intent.sourceSshTargetGeneration,
        pairingCode,
        signal: args.signal,
        assertAuthority
      })
    }
  }
}
