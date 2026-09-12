import { retainProfileLifetimeSuccessorAuthority } from '../ssh/profile-lifetime-successor-authority'
import { captureSshResetProfileIdentity } from '../ssh/ssh-reset-profile-identity'
import type { SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import {
  sshRelayResetRecordDigest,
  type SshRelayResetRetirementSelection
} from '../ssh/ssh-relay-reset-retirement-record'
import { SSH_RESET_CLIENT_INCARNATION } from './pty/provider/ssh-reset-route-retirement'
import { readSshResetProfileParticipation } from './ssh-reset-profile-participation'

/** Missing historical enrollment cannot be repaired by a newly acquired profile lock. */
export function retainSshResetSuccessorProfileAuthority(
  root: string,
  intent: SshRelayResetIntent,
  selection: SshRelayResetRetirementSelection
): () => void {
  const profile = captureSshResetProfileIdentity(root)
  profile.assertCurrent()
  const historical = readSshResetProfileParticipation(root, intent, selection)
  profile.assertCurrent()
  if (!historical) {
    throw new Error('ssh_reset_successor_participation_missing')
  }
  if (historical.clientIncarnation === SSH_RESET_CLIENT_INCARNATION) {
    throw new Error('ssh_reset_successor_same_client')
  }
  if (profile.physicalPath !== historical.participation.physicalRoot) {
    throw new Error('ssh_reset_successor_profile_changed')
  }
  const assertSuccessor = retainProfileLifetimeSuccessorAuthority(historical.participation)
  const expected = sshRelayResetRecordDigest(historical)
  const assertCurrent = () => {
    assertSuccessor()
    profile.assertCurrent()
    if (
      sshRelayResetRecordDigest(readSshResetProfileParticipation(root, intent, selection)) !==
      expected
    ) {
      throw new Error('ssh_reset_successor_participation_changed')
    }
    profile.assertCurrent()
    assertSuccessor()
  }
  assertCurrent()
  return assertCurrent
}
