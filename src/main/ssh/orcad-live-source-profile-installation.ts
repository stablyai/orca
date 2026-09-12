import type { Store } from '../persistence'
import { inspectOrcadLiveRetirementRecovery } from './orcad-live-retirement-recovery-inspection'
import { withOrcadCommittedProfileAuthority } from './orcad-committed-profile-authority'
import { bindOutgoingOrcadCatalogSource } from './orcad-outgoing-catalog-source'
import { prepareOrcadLiveSourceRetirementUnderAuthority } from './orcad-live-source-retirement-preparation'
import { installOrcadLiveProfileUnderAuthority } from './orcad-live-profile-installation'

/** Profile installation only; leaves incumbent relay authority and runtime routes intact. */
export async function installOrcadLiveSourceProfile(
  options: {
    profileDirectory: string
    store: Store
    migrationId: string
    runtime: Parameters<typeof bindOutgoingOrcadCatalogSource>[0]['runtime']
    signal: AbortSignal
  } & Pick<
    Parameters<typeof prepareOrcadLiveSourceRetirementUnderAuthority>[0],
    'remote' | 'activate'
  >
) {
  return withOrcadCommittedProfileAuthority(options, async ({ intent, cutover, ...authority }) => {
    const recovery = inspectOrcadLiveRetirementRecovery(
      options.profileDirectory,
      options.store
    ).find((entry) => entry.record.release.cutover.manifest.migrationId === options.migrationId)
    if (recovery?.state === 'conflict') {
      throw new Error('orcad_live_profile_installation_conflict')
    }
    if (recovery?.state === 'profile-installed') {
      return installOrcadLiveProfileUnderAuthority({
        ...options,
        record: recovery.record,
        assertAuthority: authority.assertAuthority
      })
    }
    const sourceAdmission = bindOutgoingOrcadCatalogSource({
      targetId: intent.manifest.source.sshTargetId,
      identities: intent.liveTerminalBindings!.map((entry) => entry.identity),
      runtime: options.runtime,
      store: options.store,
      signal: options.signal,
      assertAuthority: authority.assertAuthority
    })
    const prepared = await prepareOrcadLiveSourceRetirementUnderAuthority({
      ...options,
      ...authority,
      cutover,
      sourceAdmission
    })
    return installOrcadLiveProfileUnderAuthority({
      ...options,
      record: prepared.record,
      sourceAdmission,
      // Profile installation removes leases, but must retain the exact incumbent runtime binding.
      assertAuthority: sourceAdmission.assertRuntimeCurrent
    })
  })
}
