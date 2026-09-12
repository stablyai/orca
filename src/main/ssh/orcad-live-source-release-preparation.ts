import { inspectOrcadLiveDestinationActivations } from './orcad-live-destination-activation'
import { withOrcadLiveSourceRecovery } from './orcad-live-source-recovery'
import { assertOrcadLiveCutoverCurrent } from './orcad-live-cutover-current'
import {
  OrcadLiveSourceReleaseIntentStore,
  assertOrcadLiveSourceReleaseCompatible,
  parseOrcadLiveSourceReleaseIntent
} from './orcad-live-source-release-intent'

/** Caller retains lifecycle locks through persistence; no source route or lease is removed here. */
export async function prepareOrcadLiveSourceReleaseUnderAuthority(
  options: Parameters<typeof inspectOrcadLiveDestinationActivations>[0]
) {
  const current = await inspectOrcadLiveDestinationActivations(options)
  const assertCurrent = () =>
    assertOrcadLiveCutoverCurrent({ ...options, cutover: current.cutover })
  assertCurrent()
  const candidate = parseOrcadLiveSourceReleaseIntent({ version: 1, ...current })
  const store = new OrcadLiveSourceReleaseIntentStore(options.profileDirectory)
  const existing = store.read(candidate.identity)
  if (existing) {
    assertOrcadLiveSourceReleaseCompatible(candidate, existing)
  }
  assertCurrent()
  const intent = store.persist(existing ?? candidate)
  assertCurrent()
  return { intent, activations: current.activations }
}

export async function prepareOrcadLiveSourceRelease(
  options: Parameters<typeof withOrcadLiveSourceRecovery>[0] &
    Pick<Parameters<typeof inspectOrcadLiveDestinationActivations>[0], 'remote' | 'activate'>
) {
  return withOrcadLiveSourceRecovery(options, (context) =>
    prepareOrcadLiveSourceReleaseUnderAuthority({ ...options, ...context })
  )
}
