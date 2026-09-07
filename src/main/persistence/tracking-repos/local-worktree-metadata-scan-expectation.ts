import { isDeepStrictEqual } from 'node:util'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { getRepoKind } from '../../../shared/repo-kind'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

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
  expectedSerialized: string | null | undefined
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

function serializeMetadataRow(meta: WorktreeMeta | undefined): string | null | undefined {
  if (!meta) {
    return undefined
  }
  try {
    return JSON.stringify(meta)
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
    expectedSerialized: serializeMetadataRow(expectedMeta),
    expectedInstanceId: expectedMeta?.instanceId,
    expectedHostId: expectedMeta?.hostId
  }
}

export function indexMetadataAliasesForWorktreeIds(
  state: PersistedState,
  worktreeIds: ReadonlySet<string>
): Map<string, MetadataAliasEntry[]> {
  const indexed = new Map<string, MetadataAliasEntry[]>()
  for (const [alias, identityKeys] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    const matches = new Set<string>()
    if (worktreeIds.has(alias)) {
      matches.add(alias)
    }
    const separator = alias.indexOf('|')
    const suffix = separator === -1 ? alias : alias.slice(separator + 1)
    if (worktreeIds.has(suffix)) {
      matches.add(suffix)
    }
    for (const worktreeId of matches) {
      const entries = indexed.get(worktreeId) ?? []
      entries.push([alias, identityKeys])
      indexed.set(worktreeId, entries)
    }
  }
  return indexed
}

export function captureNativeLocalWorktreeMetadataScanExpectation(
  state: PersistedState,
  repo: Repo
): NativeLocalWorktreeMetadataScanExpectation {
  const matchingRepos = state.repos.filter((entry) => entry.id === repo.id)
  const expectedRepo = matchingRepos.length === 1 ? matchingRepos[0] : undefined
  const expectedProject = state.projects.find((project) => project.sourceRepoIds.includes(repo.id))
  const candidateIds = new Set<string>()
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    if (
      splitWorktreeId(worktreeId)?.repoId === repo.id &&
      (!meta.hostId || meta.hostId === LOCAL_EXECUTION_HOST_ID)
    ) {
      candidateIds.add(worktreeId)
    }
  }
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    if (!isWorktreeHostIdentity(alias)) {
      continue
    }
    const worktreeId = getWorktreeIdFromHostIdentity(alias)
    if (
      alias === composeWorktreeHostIdentity(LOCAL_EXECUTION_HOST_ID, worktreeId) &&
      splitWorktreeId(worktreeId)?.repoId === repo.id
    ) {
      candidateIds.add(worktreeId)
    }
  }
  const aliasesByWorktreeId = indexMetadataAliasesForWorktreeIds(state, candidateIds)
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
    expected.expectedSerialized !== null &&
    serializeMetadataRow(current) === expected.expectedSerialized &&
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

/**
 * Whether the local host is structurally allowed to drop this row, ignoring concurrent-change checks.
 *
 * Pure over persisted state — no filesystem, no expectation — so a caller can decide *before* paying
 * for a `stat` whether a delete could ever accept the row. Several of these predicates reject the
 * same row on every pass forever (a locator also known on a remote host keeps a second alias; a
 * legacy row pinned to another host; identity rows that drifted or dangle), which is what turned the
 * prune into an unbounded no-progress loop in #17775.
 */
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
