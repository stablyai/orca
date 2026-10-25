/** The relay-era SSH target as a migration source: keyed by its target id, paths unchanged. */
import { ORCAD_MIGRATION_SSH_RELAY_SOURCE_KIND } from '../../shared/orcad-migration/orcad-migration-source-kind'
import type { SshTarget } from '../../shared/ssh-types'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import type { Store } from '../persistence'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import { IDENTITY_ORCAD_MIGRATION_PATH_REWRITER } from './orcad-migration-path-rewrite'
import type {
  OrcadMigrationSource,
  OrcadMigrationSourceCutoverPort
} from './orcad-migration-source'
import { assertOrcadMigrationSourceUnchanged } from './orcad-migration-source-assertions'
import {
  fenceOrcadMigrationSource,
  releaseOrcadMigrationFence,
  resolveOrcadMigrationFence
} from './orcad-migration-source-fence'
import {
  assessOrcadMigrationTerminals,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './orcad-migration-terminal-gate'
import type { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'
import type { OrcadMigrationPreflightStore } from './targets/ssh-target-orcad-preflight'
import type { OrcadMigrationPaneLeasePredicate } from './orcad-migration-bridged-panes'

type SshRelayCutoverDeps = {
  userDataPath: string
  store: OrcadMigrationPreflightStore
  claims: SshTargetOrcadClaims
  /** Rebuilt for every check when `store` is a copy that would never see a later edit. */
  freshSource?: () => OrcadMigrationPreflightStore
  signal?: AbortSignal
}

/** The fenced SSH target a journaled cutover names. */
export function sshRelayMigrationCutoverPort(
  deps: SshRelayCutoverDeps
): OrcadMigrationSourceCutoverPort {
  return {
    verifyFence: (cutover) =>
      assertOrcadMigrationSourceUnchanged(
        { userDataPath: deps.userDataPath, store: deps.freshSource?.() ?? deps.store },
        cutover
      ),
    releaseFence: (cutover) => releaseOrcadMigrationFence(deps, cutover)
  }
}

export function createSshRelayMigrationSource(
  deps: SshRelayCutoverDeps & {
    store: OrcadMigrationPreflightStore &
      Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>
    target: SshTarget
    /** Every relay endpoint on the host's account; without it exit can never be proven. */
    censusHost?: CensusHostRelayTerminals | null
    isBridgedPaneLease?: OrcadMigrationPaneLeasePredicate
  }
): OrcadMigrationSource {
  const { userDataPath, store, target } = deps
  return {
    ...sshRelayMigrationCutoverPort(deps),
    kind: ORCAD_MIGRATION_SSH_RELAY_SOURCE_KIND,
    journalKey: target.id,
    collectCatalog: () => collectOrcadMigrationSourceCatalog(store, target),
    exportManifest: (options = {}) =>
      createOrcadMigrationManifest(store, target, {
        ...options,
        rewrite: IDENTITY_ORCAD_MIGRATION_PATH_REWRITER
      }),
    assessTerminals: () => assessOrcadMigrationTerminals(store, target.id, deps.censusHost),
    retireProvenExitedTerminals: (proof) => retireProvenExitedLeases(store, target.id, proof),
    resolveFence: () => resolveOrcadMigrationFence(userDataPath, target),
    acquireFence: (args) =>
      fenceOrcadMigrationSource({
        userDataPath,
        store,
        claims: deps.claims,
        targetId: target.id,
        isBridgedPaneLease: deps.isBridgedPaneLease,
        ...args
      })
  }
}
