import { readFile, readdir } from 'node:fs/promises'
import {
  getOrcaProfileIndexPath,
  getOrcaProfileMoveIntentDirectory
} from '../../orca-profiles/profile-storage-paths'
import { getOrcaProfileStateDatabaseFile } from '../../../shared/profile-state-storage-paths'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../../shared/orca-profiles'
import { canonicalTerminalClaimDatabase } from '../profile-state/profile-state-terminal-claim-location'
import { isRecord } from '../profile-state/profile-state-document-validation'
import { isProfileTerminalClaimsRequest } from '../profile-state/profile-state-terminal-claims-contract'
import type { StoreRuntimeState } from './store-runtime-state'
import type {
  LegacyTerminalIdentityClaims,
  LegacyTerminalCatalogEpoch
} from './legacy-terminal-identity-claims'
import {
  enqueuePrimaryStateOperation,
  type PrimaryStateWriteOperations
} from './primary-state-writes'

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}
async function noPendingMove(root: string): Promise<boolean> {
  try {
    return !(await readdir(getOrcaProfileMoveIntentDirectory(root))).some((name) =>
      /^[0-9a-f-]{36}\.json$/.test(name)
    )
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return true
    }
    throw error
  }
}

/** Index presentation damage must never silently discard a retained claimant. */
async function profileIds(root: string): Promise<string[]> {
  const path = getOrcaProfileIndexPath(root)
  const primary = await optionalFile(path)
  const raw = primary ?? (await optionalFile(`${path}.bak`))
  if (raw === undefined) {
    return []
  }
  const index: unknown = JSON.parse(raw)
  if (
    !isRecord(index) ||
    index.schemaVersion !== ORCA_PROFILE_INDEX_SCHEMA_VERSION ||
    !Array.isArray(index.profiles)
  ) {
    throw new Error('Unknown profile membership')
  }
  const ids = index.profiles.map((profile: unknown) => {
    if (
      !isRecord(profile) ||
      !isProfileTerminalClaimsRequest({ userDataPath: root, profileId: profile.id })
    ) {
      throw new Error('Invalid profile membership')
    }
    const request = { userDataPath: root, profileId: profile.id }
    if (!isProfileTerminalClaimsRequest(request)) {
      throw new Error('Invalid profile identity')
    }
    return request.profileId
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error('Ambiguous profile membership')
  }
  return ids
}

/** One optional batch uses the existing writer queue; no profile document is read on main. */
export class LegacyTerminalProfileCatalog {
  private activeChanges = 0
  private running: Promise<void> | undefined
  private pending = false
  private readonly knownLocations = new Map<string, string>()
  private readonly changed = new Set<string>()
  private allChanged = true

  constructor(
    private readonly runtime: StoreRuntimeState,
    private readonly writes: PrimaryStateWriteOperations,
    private readonly claims: LegacyTerminalIdentityClaims
  ) {
    if (runtime.userDataPath) {
      claims.invalidateExternalCatalog()
      this.refresh()
    }
  }

  beginChange(): (changedIds?: readonly string[]) => void {
    this.activeChanges++
    this.claims.invalidateExternalCatalog()
    let finished = false
    return (ids) => {
      if (finished) {
        return
      }
      finished = true
      if (ids === undefined) {
        this.allChanged = true
      } else {
        for (const id of ids) {
          this.changed.add(id)
        }
      }
      this.activeChanges--
      if (!this.activeChanges) {
        this.refresh()
      }
    }
  }

  invalidate(): void {
    this.claims.invalidateExternalCatalog()
    this.pending = false
  }

  private open(): boolean {
    return (
      !this.activeChanges &&
      !this.runtime.writesFrozen &&
      !this.runtime.quitFlushStarted &&
      !this.runtime.profileMaintenancePending &&
      !this.runtime.fatalMutationError
    )
  }

  private refresh(): void {
    if (!this.runtime.userDataPath || !this.open()) {
      return
    }
    this.pending = true
    if (this.running) {
      return
    }
    this.running = this.drain().finally(() => {
      this.running = undefined
      if (this.pending) {
        this.refresh()
      }
    })
  }

  private async drain(): Promise<void> {
    while (this.pending && this.open()) {
      this.pending = false
      const epoch = this.claims.captureExternalCatalog()
      const changed = this.allChanged ? undefined : new Set(this.changed)
      try {
        await this.read(epoch, changed)
      } catch {
        this.claims.publishExternalCatalog(epoch, [], false)
      }
      if (epoch === this.claims.captureExternalCatalog() && epoch.complete) {
        this.allChanged = false
        this.changed.clear()
      }
    }
  }

  private async read(
    epoch: LegacyTerminalCatalogEpoch,
    changed: ReadonlySet<string> | undefined
  ): Promise<void> {
    await this.claims.canonicalProfileReady
    const root = this.claims.canonicalProfile
    const current = () => this.open() && epoch === this.claims.captureExternalCatalog()
    if (!root || !current() || !(await noPendingMove(root))) {
      this.claims.publishExternalCatalog(epoch, [], false)
      return
    }
    const ids = await profileIds(root)
    const locations = new Map<string, string>()
    const seenLocations = new Set<string>()
    const active = ids.length ? this.runtime.profileStateLocation : undefined
    const owned = active ? await canonicalTerminalClaimDatabase(active.databaseFile) : undefined
    const staged: string[] = []
    const accepted = new Map<string, string>()
    for (const profileId of ids) {
      if (!current()) {
        return
      }
      const location = await canonicalTerminalClaimDatabase(
        getOrcaProfileStateDatabaseFile(profileId, root)
      )
      if (seenLocations.has(location)) {
        throw new Error('Aliased profile membership')
      }
      seenLocations.add(location)
      locations.set(profileId, location)
      if (location === owned) {
        if (profileId !== active?.profileId) {
          throw new Error('Ambiguous active profile identity')
        }
        continue
      }
      if (
        !changed?.has(profileId) &&
        changed !== undefined &&
        this.knownLocations.get(profileId) === location
      ) {
        accepted.set(profileId, location)
        continue
      }
      const authority = this.runtime.profileStateAuthority
      if (!authority?.asynchronous || !authority.readTerminalClaims || !current()) {
        throw new Error('No live catalog reader')
      }
      const read = authority.readTerminalClaims.bind(authority)
      const result = await enqueuePrimaryStateOperation(this.writes, async () => {
        if (!current()) {
          return { kind: 'unknown' as const }
        }
        return read({ userDataPath: root, profileId })
      })
      if (!current()) {
        return
      }
      if (result.kind !== 'known' || result.location !== location) {
        throw new Error('Unknown inactive terminal claims')
      }
      staged.push(...result.numericIds)
      accepted.set(profileId, location)
    }
    if (ids.length && ![...locations.values()].includes(owned ?? '')) {
      throw new Error('Active profile is absent from catalog')
    }
    if (!current()) {
      return
    }
    if (!(await noPendingMove(root))) {
      this.claims.publishExternalCatalog(epoch, [], false)
      return
    }
    if (!current()) {
      return
    }
    this.knownLocations.clear()
    for (const [id, location] of accepted) {
      this.knownLocations.set(id, location)
    }
    this.claims.publishExternalCatalog(epoch, staged, true)
  }
}
