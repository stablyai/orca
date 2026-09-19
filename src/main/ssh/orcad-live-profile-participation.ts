import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { readCurrentProfileLifetimeParticipation } from './profile-lifetime-admission'
import {
  parseProfileLifetimeParticipation,
  profileFilesystemIdentitySchema
} from './profile-lifetime-participation'
import { captureSshResetProfileIdentity } from './ssh-reset-profile-identity'
import { OrcadOutgoingEvidenceStore } from './orcad-outgoing-evidence-store'
import {
  OrcadLiveCutoverIntentStore,
  parseOrcadLiveCutoverIntent
} from './orcad-live-cutover-intent-store'

const schema = z.strictObject({
  version: z.literal(1),
  identity: z.unknown().transform(parsePtyOwnershipTransferWireIdentity),
  intentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  physicalProfile: z
    .string()
    .min(1)
    .max(32768)
    .refine((path) => isAbsolute(path) && !path.includes('\0')),
  participation: z.unknown().transform(parseProfileLifetimeParticipation),
  profileIdentity: profileFilesystemIdentitySchema
})
const digest = (value: unknown) =>
  createHash('sha256').update(serializeOrcadMigrationValue(value)).digest('hex')

function binding(profileDirectory: string, value: unknown) {
  const intent = parseOrcadLiveCutoverIntent(value)
  const intentSha256 = digest(intent)
  const parse = (value: unknown) => {
    const record = schema.parse(value)
    if (record.intentSha256 !== intentSha256) {
      throw new Error('orcad_live_participation_intent_changed')
    }
    return record
  }
  const records = new OrcadOutgoingEvidenceStore(
    join(profileDirectory, 'orcad-live-profile-participation'),
    parse,
    'orcad_live_participation'
  )
  return { intent, intentSha256, records }
}

/** Read-only historical evidence; neither absence nor a successor lock enrolls an earlier client. */
export function readOrcadLiveProfileParticipation(profileDirectory: string, intent: unknown) {
  const b = binding(profileDirectory, intent)
  return b.records.read(b.intent.identity)
}

function captureCurrent(profileDirectory: string) {
  const participation = readCurrentProfileLifetimeParticipation()
  if (!participation) {
    return null
  }
  const profile = captureSshResetProfileIdentity(profileDirectory)
  const child = relative(participation.physicalRoot, profile.physicalPath)
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('orcad_live_participation_root_changed')
  }
  return { participation, profile }
}

/** Same-process continuation only; successor recovery needs independent retirement evidence. */
export function retainOrcadLiveProfileParticipation(profileDirectory: string, value: unknown) {
  const b = binding(profileDirectory, value)
  const saved = b.records.read(b.intent.identity)
  const current = captureCurrent(profileDirectory)
  if (!saved && !current && !b.intent.profileParticipationRequired) {
    return undefined
  }
  if (!saved || !current) {
    throw new Error('orcad_live_participation_unavailable')
  }
  const expected = digest(saved)
  const assertCurrent = () => {
    current.profile.assertCurrent()
    if (
      saved.physicalProfile !== current.profile.physicalPath ||
      digest(saved.profileIdentity) !== digest(current.profile.filesystemIdentity) ||
      digest(readCurrentProfileLifetimeParticipation()) !== digest(saved.participation) ||
      digest(b.records.read(b.intent.identity)) !== expected
    ) {
      throw new Error('orcad_live_participation_changed')
    }
    current.profile.assertCurrent()
  }
  assertCurrent()
  return assertCurrent
}

/** Caller holds lifecycle locks; persist before the first creation fence or owner mutation. */
export function prepareOrcadLiveProfileParticipation(options: {
  profileDirectory: string
  intent: unknown
  assertAuthority: () => void
}) {
  const b = binding(options.profileDirectory, options.intent)
  const current = captureCurrent(options.profileDirectory)
  const saved = b.records.read(b.intent.identity)
  if (!current) {
    if (saved || b.intent.profileParticipationRequired) {
      throw new Error('orcad_live_participation_unavailable')
    }
    return undefined
  }
  if (!saved && new OrcadLiveCutoverIntentStore(options.profileDirectory).read(b.intent.identity)) {
    throw new Error('orcad_live_participation_historical_missing')
  }
  if (!b.intent.profileParticipationRequired) {
    throw new Error('orcad_live_participation_marker_required')
  }
  const assertCurrent = () => {
    options.assertAuthority()
    current.profile.assertCurrent()
    if (digest(readCurrentProfileLifetimeParticipation()) !== digest(current.participation)) {
      throw new Error('orcad_live_participation_changed')
    }
  }
  assertCurrent()
  b.records.persist({
    version: 1,
    identity: b.intent.identity,
    intentSha256: b.intentSha256,
    physicalProfile: current.profile.physicalPath,
    profileIdentity: current.profile.filesystemIdentity,
    participation: current.participation
  })
  assertCurrent()
  return retainOrcadLiveProfileParticipation(options.profileDirectory, b.intent)
}
