import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import { readCurrentProfileLifetimeParticipation } from './profile-lifetime-admission'
import {
  readOrcadLiveProfileParticipation,
  retainOrcadLiveProfileParticipation
} from './orcad-live-profile-participation'
import { retainOrcadLiveSuccessorProfileAuthority } from './orcad-live-successor-profile-authority'
import {
  OrcadLiveCutoverIntentStore,
  parseOrcadLiveCutoverIntent
} from './orcad-live-cutover-intent-store'

/** Select once from native participation; an authority failure never selects another mode. */
export function selectOrcadLiveResumeAuthority(profileDirectory: string, value: unknown) {
  const intent = parseOrcadLiveCutoverIntent(value)
  const intents = new OrcadLiveCutoverIntentStore(profileDirectory)
  const expected = serializeOrcadMigrationValue(intent)
  const assertIntent = () => {
    if (serializeOrcadMigrationValue(intents.read(intent.identity)) !== expected) {
      throw new Error('orcad_live_resume_intent_changed')
    }
  }
  assertIntent()
  const historical = readOrcadLiveProfileParticipation(profileDirectory, intent)
  const current = readCurrentProfileLifetimeParticipation()
  const mode =
    historical &&
    current &&
    historical.participation.processIncarnation !== current.processIncarnation
      ? ('successor' as const)
      : ('original' as const)
  const assertParticipation =
    mode === 'successor'
      ? retainOrcadLiveSuccessorProfileAuthority(profileDirectory, intent)
      : retainOrcadLiveProfileParticipation(profileDirectory, intent)
  const assertCurrent = () => {
    assertIntent()
    assertParticipation?.()
    assertIntent()
  }
  assertCurrent()
  return { mode, assertCurrent }
}
