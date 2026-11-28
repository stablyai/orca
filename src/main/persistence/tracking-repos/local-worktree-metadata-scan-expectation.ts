import { isDeepStrictEqual } from 'node:util'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { Project } from '../../../shared/project/project-types'
import type { Repo } from '../../../shared/repository/repo-types'
import { getRepoKind } from '../../../shared/repository/repo-kind'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { fingerprintString } from '../../../shared/text/string-fingerprint'

const LOCAL_HOST_IDENTITY_PREFIX = `${LOCAL_EXECUTION_HOST_ID}|`

type CapturedLocalRepoIdentity = Readonly<
  Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> & {
    kind: ReturnType<typeof getRepoKind>
    expectedRepo: Repo | undefined
  }
>

type CapturedLocalRoutingIdentity = Readonly<{
  expectedProject: Project | undefined
  expectedProjectUpdatedAt: number | undefined
  expectedSettings: GlobalSettings
}>

type MetadataRowExpectation = Readonly<{
  expectedPresent: boolean
  expectedMeta: WorktreeMeta | undefined
  expectedFingerprint: string | null | undefined
  expectedInstanceId: string | undefined
  expectedHostId: WorktreeMeta['hostId']
}>

type MetadataAliasExpectation = Readonly<{
  alias: string
  expectedAlias: string[]
  expectedIdentityKeys: readonly string[]
  expectedIdentityRows: readonly (MetadataRowExpectation & { identityKey: string })[]
}>

export type LocalWorktreeMetadataPruneExpectation = Readonly<{
  worktreeId: string
  expectedLegacy: MetadataRowExpectation
  expectedAliases: readonly MetadataAliasExpectation[]
}>

export type NativeLocalWorktreeMetadataScanExpectation = Readonly<{
  repo: CapturedLocalRepoIdentity
  routing: CapturedLocalRoutingIdentity
  metadata: readonly LocalWorktreeMetadataPruneExpectation[]
}>

type MetadataAliasEntry = readonly [alias: string, identityKeys: string[]]

function fingerprintMetadataRow(meta: WorktreeMeta | undefined): string | null | undefined {
  if (!meta) {
    return undefined
  }
  try {
    return fingerprintString(JSON.stringify(meta))
  } catch {
    return null
  }
}

function captureRow(
  record: Readonly<Record<string, WorktreeMeta>> | undefined,
  key: string
): MetadataRowExpectation {
  const expectedPresent = Object.hasOwn(record ?? {}, key)
  const expectedMeta = record?.[key]
  return {
    expectedPresent,
    expectedMeta,
    expectedFingerprint: fingerprintMetadataRow(expectedMeta),
    expectedInstanceId: expectedMeta?.instanceId,
    expectedHostId: expectedMeta?.hostId
  }
}

export function indexMetadataAliasesForWorktreeIds(
  state: PersistedState,
  worktreeIds: ReadonlySet<string>,
  repoPrefix?: string
): Map<string, MetadataAliasEntry[]> {
  const indexed = new Map<string, MetadataAliasEntry[]>()
  const aliases = state.worktreeIdentityAliases
  if (!aliases || worktreeIds.size === 0) {
    return indexed
  }
  for (const alias in aliases) {
    if (!Object.hasOwn(aliases, alias)) {
      continue
    }
    const directMatch =
      (repoPrefix === undefined || alias.startsWith(repoPrefix)) && worktreeIds.has(alias)
    const separator = alias.indexOf('|')
    const hasSuffixCandidate =
      separator !== -1 && (repoPrefix === undefined || alias.startsWith(repoPrefix, separator + 1))
    if (!directMatch && !hasSuffixCandidate) {
      continue
    }
    const identityKeys = aliases[alias]!
    if (directMatch) {
      const entries = indexed.get(alias)
      if (entries) {
        entries.push([alias, identityKeys])
      } else {
        indexed.set(alias, [[alias, identityKeys]])
      }
    }
    if (hasSuffixCandidate) {
      const suffix = alias.slice(separator + 1)
      if (suffix !== alias && worktreeIds.has(suffix)) {
        const entries = indexed.get(suffix)
        if (entries) {
          entries.push([alias, identityKeys])
        } else {
          indexed.set(suffix, [[alias, identityKeys]])
        }
      }
    }
  }
  return indexed
}

export function captureNativeLocalWorktreeMetadataScanExpectation(
  state: PersistedState,
  repo: Repo
): NativeLocalWorktreeMetadataScanExpectation {
  let expectedRepo: Repo | undefined
  for (const entry of state.repos) {
    if (entry.id === repo.id) {
      if (expectedRepo !== undefined) {
        expectedRepo = undefined
        break
      }
      expectedRepo = entry
    }
  }
  const expectedProject = state.projects.find((project) => project.sourceRepoIds.includes(repo.id))
  const candidateIds = new Set<string>()
  const canMatchRepoId = !repo.id.includes(WORKTREE_ID_SEPARATOR)
  const repoPrefix = canMatchRepoId ? `${repo.id}${WORKTREE_ID_SEPARATOR}` : undefined
  if (repoPrefix !== undefined) {
    const worktreeMeta = state.worktreeMeta
    for (const worktreeId in worktreeMeta) {
      if (!Object.hasOwn(worktreeMeta, worktreeId) || !worktreeId.startsWith(repoPrefix)) {
        continue
      }
      const meta = worktreeMeta[worktreeId]!
      if (!meta.hostId || meta.hostId === LOCAL_EXECUTION_HOST_ID) {
        candidateIds.add(worktreeId)
      }
    }
    const aliases = state.worktreeIdentityAliases
    if (aliases) {
      const localRepoPrefix = `${LOCAL_HOST_IDENTITY_PREFIX}${repoPrefix}`
      for (const alias in aliases) {
        if (!Object.hasOwn(aliases, alias) || !alias.startsWith(localRepoPrefix)) {
          continue
        }
        candidateIds.add(alias.slice(LOCAL_HOST_IDENTITY_PREFIX.length))
      }
    }
  }
  const aliasesByWorktreeId = indexMetadataAliasesForWorktreeIds(state, candidateIds, repoPrefix)
  return {
    repo: {
      id: repo.id,
      path: repo.path,
      connectionId: repo.connectionId,
      executionHostId: repo.executionHostId,
      kind: getRepoKind(repo),
      expectedRepo
    },
    routing: {
      expectedProject,
      expectedProjectUpdatedAt: expectedProject?.updatedAt,
      expectedSettings: state.settings
    },
    metadata: [...candidateIds].map((worktreeId) => ({
      worktreeId,
      expectedLegacy: captureRow(state.worktreeMeta, worktreeId),
      expectedAliases: (aliasesByWorktreeId.get(worktreeId) ?? []).map(([alias, identityKeys]) => ({
        alias,
        expectedAlias: identityKeys,
        expectedIdentityKeys: [...identityKeys],
        expectedIdentityRows: identityKeys.map((identityKey) => ({
          identityKey,
          ...captureRow(state.worktreeMetaByIdentity, identityKey)
        }))
      }))
    }))
  }
}

function rowStillMatches(
  record: Readonly<Record<string, WorktreeMeta>> | undefined,
  key: string,
  expected: MetadataRowExpectation
): boolean {
  const current = record?.[key]
  return (
    Object.hasOwn(record ?? {}, key) === expected.expectedPresent &&
    current === expected.expectedMeta &&
    expected.expectedFingerprint !== null &&
    fingerprintMetadataRow(current) === expected.expectedFingerprint &&
    current?.instanceId === expected.expectedInstanceId &&
    current?.hostId === expected.expectedHostId
  )
}

function aliasesStillMatch(
  state: PersistedState,
  expected: LocalWorktreeMetadataPruneExpectation,
  currentAliases: readonly MetadataAliasEntry[]
): boolean {
  if (currentAliases.length !== expected.expectedAliases.length) {
    return false
  }
  const currentByAlias = new Map(currentAliases)
  return expected.expectedAliases.every((aliasExpectation) => {
    const current = currentByAlias.get(aliasExpectation.alias)
    return Boolean(
      current &&
      current === aliasExpectation.expectedAlias &&
      current.length === aliasExpectation.expectedIdentityKeys.length &&
      current.every((key, index) => key === aliasExpectation.expectedIdentityKeys[index]) &&
      aliasExpectation.expectedIdentityRows.every(({ identityKey, ...row }) =>
        rowStillMatches(state.worktreeMetaByIdentity, identityKey, row)
      )
    )
  })
}

/** Reject structurally unremovable rows before filesystem probes; repeated refusals caused #17775. */
export function isLocallyRemovableWorktreeMetadataRow(
  state: PersistedState,
  worktreeId: string,
  currentAliases: readonly MetadataAliasEntry[]
): boolean {
  const localAlias = composeWorktreeHostIdentity(LOCAL_EXECUTION_HOST_ID, worktreeId)
  if (currentAliases.some(([alias]) => alias !== localAlias)) {
    return false
  }
  const legacy = state.worktreeMeta[worktreeId]
  const identityKeys = state.worktreeIdentityAliases?.[localAlias]
  if (identityKeys && identityKeys.length !== 1) {
    return false
  }
  const canonical = identityKeys?.[0] ? state.worktreeMetaByIdentity?.[identityKeys[0]] : undefined
  // An archived workspace's checkout is missing on purpose; its row is the workspace.
  if (legacy?.archivedCheckout || canonical?.archivedCheckout) {
    return false
  }
  return !(
    (legacy?.hostId && legacy.hostId !== LOCAL_EXECUTION_HOST_ID) ||
    (canonical?.hostId && canonical.hostId !== LOCAL_EXECUTION_HOST_ID) ||
    (identityKeys && !canonical) ||
    (legacy && canonical && !isDeepStrictEqual(legacy, canonical)) ||
    (!legacy && !canonical)
  )
}

export function removeRevalidatedLocalWorktreeMetadata(
  state: PersistedState,
  expected: LocalWorktreeMetadataPruneExpectation,
  currentAliases: readonly MetadataAliasEntry[],
  removedIdentityKeys?: Set<string>
): boolean {
  if (
    !rowStillMatches(state.worktreeMeta, expected.worktreeId, expected.expectedLegacy) ||
    !aliasesStillMatch(state, expected, currentAliases) ||
    !isLocallyRemovableWorktreeMetadataRow(state, expected.worktreeId, currentAliases)
  ) {
    return false
  }
  const localAlias = composeWorktreeHostIdentity(LOCAL_EXECUTION_HOST_ID, expected.worktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[localAlias]
  if (identityKeys?.[0]) {
    removedIdentityKeys?.add(identityKeys[0])
  }
  delete state.worktreeMeta[expected.worktreeId]
  delete state.worktreeIdentityAliases?.[localAlias]
  return true
}
