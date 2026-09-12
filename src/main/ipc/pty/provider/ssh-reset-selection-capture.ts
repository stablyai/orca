import type { IPtyProvider } from '../../../providers/types'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  parseSshRelayResetIntent,
  type SshRelayResetIntent
} from '../../../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  sshRelayResetRecordDigest
} from '../../../ssh/ssh-relay-reset-retirement-record'
import { ptyOwnership, ptyIncarnationById } from './ownership-state'
import { sshProviders, sshProvidersByGeneration } from './registry'
import { assertPtyRouteAdmissionAllowed } from './pty-route-refusal'
import { SSH_RESET_CLIENT_INCARNATION } from './ssh-reset-route-retirement'

/** Snapshot the complete local target selection; caller rechecks it before sending reset. */
export function captureSshResetRetirementSelection(options: {
  intent: SshRelayResetIntent
  expectedProvider: IPtyProvider
  readLeases: () => readonly SshRemotePtyLease[]
  assertAuthority: () => void
  retiredAt?: number
}) {
  const intent = parseSshRelayResetIntent(options.intent)
  const { expectedProvider, readLeases, assertAuthority } = options
  const providerGeneration = (expectedProvider as { providerGeneration?: number })
    .providerGeneration
  const retiredAt = options.retiredAt ?? Date.now()
  const readSelection = () => {
    assertAuthority()
    const leases = readLeases()
    assertAuthority()
    if (
      !Number.isSafeInteger(providerGeneration) ||
      providerGeneration! < 1 ||
      sshProviders.get(intent.targetId) !== expectedProvider ||
      sshProvidersByGeneration.get(providerGeneration!) !== expectedProvider ||
      (expectedProvider as { providerGeneration?: number }).providerGeneration !==
        providerGeneration
    ) {
      throw new Error('ssh_reset_selection_provider_changed')
    }
    const ids = new Set([...ptyOwnership.keys(), ...ptyIncarnationById.keys()])
    const routes = Array.from(ids)
      .filter(
        (id) =>
          ptyOwnership.get(id) === intent.targetId ||
          parseAppSshPtyId(id)?.connectionId === intent.targetId
      )
      .map((appPtyId) => {
        if (ptyOwnership.get(appPtyId) !== intent.targetId) {
          throw new Error('ssh_reset_selection_route_unowned')
        }
        assertPtyRouteAdmissionAllowed(appPtyId)
        return { appPtyId, incarnationId: ptyIncarnationById.get(appPtyId), providerGeneration }
      })
      .sort((a, b) => (a.appPtyId < b.appPtyId ? -1 : a.appPtyId > b.appPtyId ? 1 : 0))
    return parseSshRelayResetRetirementSelection(
      {
        version: 1,
        intentSha256: sshRelayResetRecordDigest(intent),
        clientIncarnation: SSH_RESET_CLIENT_INCARNATION,
        retiredAt,
        leases: [...leases].sort((a, b) => (a.ptyId < b.ptyId ? -1 : a.ptyId > b.ptyId ? 1 : 0)),
        routes
      },
      intent
    )
  }
  const selection = readSelection()
  const digest = sshRelayResetRecordDigest(selection)
  const assertCurrent = () => {
    if (sshRelayResetRecordDigest(readSelection()) !== digest) {
      throw new Error('ssh_reset_selection_changed')
    }
  }
  assertCurrent()
  return { selection, assertCurrent }
}
