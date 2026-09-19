import { join } from 'node:path'
import { z } from 'zod'
import { readCurrentProfileLifetimeParticipation } from '../ssh/profile-lifetime-admission'
import { parseProfileLifetimeParticipation } from '../ssh/profile-lifetime-participation'
import { captureSshResetProfileIdentity } from '../ssh/ssh-reset-profile-identity'
import { SshRelayResetRecordFiles } from '../ssh/ssh-relay-reset-record-files'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  sshRelayResetRecordDigest,
  type SshRelayResetRetirementSelection
} from '../ssh/ssh-relay-reset-retirement-record'
import { SSH_RESET_CLIENT_INCARNATION } from './pty/provider/ssh-reset-route-retirement'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const recordSchema = z.strictObject({
  version: z.literal(1),
  intentSha256: digest,
  selectionSha256: digest,
  clientIncarnation: z.string().min(1).max(1024),
  participation: z.unknown().transform(parseProfileLifetimeParticipation)
})

function binding(
  root: string,
  value: SshRelayResetIntent,
  selected: SshRelayResetRetirementSelection
) {
  const intent = parseSshRelayResetIntent(value)
  const selection = parseSshRelayResetRetirementSelection(selected, intent)
  const intentSha256 = sshRelayResetRecordDigest(intent)
  const selectionSha256 = sshRelayResetRecordDigest(selection)
  const files = new SshRelayResetRecordFiles(join(root, 'ssh-reset-profile-participation'))
  const parse = (value: unknown) => {
    const record = recordSchema.parse(value)
    if (
      record.intentSha256 !== intentSha256 ||
      record.selectionSha256 !== selectionSha256 ||
      record.clientIncarnation !== selection.clientIncarnation
    ) {
      throw new Error('ssh_reset_profile_participation_binding_changed')
    }
    return record
  }
  return { files, path: files.path(intentSha256), parse, intentSha256, selectionSha256, selection }
}

/** Missing historical evidence stays missing; reading never enrolls an earlier client. */
export function readSshResetProfileParticipation(
  root: string,
  intent: SshRelayResetIntent,
  selection: SshRelayResetRetirementSelection
) {
  const record = binding(root, intent, selection)
  return record.files.readRecord(record.path, record.parse)
}

export function prepareSshResetProfileParticipation(options: {
  root: string
  intent: SshRelayResetIntent
  selection: SshRelayResetRetirementSelection
  assertAuthority: () => void
}): (() => Promise<() => void>) | undefined {
  const participation = readCurrentProfileLifetimeParticipation()
  if (!participation) {
    return undefined
  }
  const b = binding(options.root, options.intent, options.selection)
  if (b.selection.clientIncarnation !== SSH_RESET_CLIENT_INCARNATION) {
    throw new Error('ssh_reset_profile_participation_foreign_client')
  }
  const rootIdentity = captureSshResetProfileIdentity(options.root)
  if (rootIdentity.physicalPath !== participation.physicalRoot) {
    throw new Error('ssh_reset_profile_participation_root_changed')
  }
  const record = b.parse({
    version: 1,
    intentSha256: b.intentSha256,
    selectionSha256: b.selectionSha256,
    clientIncarnation: b.selection.clientIncarnation,
    participation
  })
  const expected = sshRelayResetRecordDigest(record)
  const assertCurrent = () => {
    options.assertAuthority()
    rootIdentity.assertCurrent()
    if (
      sshRelayResetRecordDigest(readCurrentProfileLifetimeParticipation()) !==
      sshRelayResetRecordDigest(participation)
    ) {
      throw new Error('ssh_reset_profile_participation_changed')
    }
  }
  return async () => {
    assertCurrent()
    await b.files.withTargetLock(b.intentSha256, () =>
      b.files.writeRecord(b.path, record, b.parse, assertCurrent)
    )
    const assertDurable = () => {
      assertCurrent()
      if (sshRelayResetRecordDigest(b.files.readRecord(b.path, b.parse)) !== expected) {
        throw new Error('ssh_reset_profile_participation_write_unconfirmed')
      }
      assertCurrent()
    }
    assertDurable()
    return assertDurable
  }
}
