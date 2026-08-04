import { join } from 'node:path'
import type { MemorySnapshot, SnapshotAvailability } from '../../shared/memory-snapshot'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { OrcaHooks, Repo } from '../../shared/types'
import { inspectOrcaYaml } from '../../shared/orca-yaml'
import {
  reconcileFilesystemHostFailureDomains,
  readOrcaYamlThroughFilesystemHost
} from '../filesystem-host/filesystem-host-read-authority'

export type OrcaYamlContentState = 'missing' | 'valid' | 'invalid'

export type OrcaYamlSnapshotValue = {
  contentState: OrcaYamlContentState
  hooks: OrcaHooks | null
  mayNeedUpdate: boolean
  sharedDirectories: readonly string[]
}

export type OrcaYamlSnapshot = MemorySnapshot<OrcaYamlSnapshotValue> & {
  lastError: string | null
}

type SnapshotEntry = {
  value: OrcaYamlSnapshotValue | null
  stale: boolean
  availability: SnapshotAvailability
  observedAt: number | null
  lastError: string | null
  generation: number
}
type ContentReader = () => Promise<string | null>
type SnapshotRefreshFlight = {
  generation: number
  promise: Promise<OrcaYamlSnapshot>
}

const SNAPSHOT_REVALIDATION_MS = 30_000

const RECOGNIZED_KEYS = new Set([
  'scripts',
  'issueCommand',
  'defaultTabs',
  'environmentRecipes',
  'worktree'
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function failureAvailability(
  error: unknown
): Extract<SnapshotAvailability, 'denied' | 'unavailable'> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable'
}

export class OrcaYamlSnapshotStore {
  private readonly entries = new Map<string, SnapshotEntry>()
  private readonly inFlight = new Map<string, SnapshotRefreshFlight>()
  private readonly removedGenerations = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  read(key: string): OrcaYamlSnapshot {
    const entry = this.entries.get(key)
    return entry
      ? {
          value: entry.value,
          stale: entry.stale,
          age: entry.observedAt === null ? null : Math.max(0, this.now() - entry.observedAt),
          availability: entry.availability,
          lastError: entry.lastError
        }
      : { value: null, stale: true, age: null, availability: 'unavailable', lastError: null }
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  publishContent(key: string, content: string | null): void {
    const generation = this.generation(key) + 1
    this.removedGenerations.delete(key)
    this.entries.set(key, {
      value: this.parse(content),
      stale: false,
      availability: content === null ? 'missing' : 'ready',
      observedAt: this.now(),
      lastError: null,
      generation
    })
  }

  invalidate(key: string, error?: unknown): void {
    const previous = this.entries.get(key)
    const generation = this.generation(key) + 1
    this.removedGenerations.delete(key)
    this.entries.set(key, {
      value: previous?.value ?? null,
      stale: true,
      availability: failureAvailability(error),
      observedAt: previous?.observedAt ?? null,
      lastError: error === undefined ? null : errorMessage(error),
      generation
    })
  }

  refresh(key: string, reader: ContentReader): Promise<OrcaYamlSnapshot> {
    const requestedGeneration = this.generation(key)
    const existing = this.inFlight.get(key)
    if (existing) {
      if (existing.generation === requestedGeneration) {
        return existing.promise
      }
      return existing.promise.then(() =>
        this.generation(key) === requestedGeneration ? this.refresh(key, reader) : this.read(key)
      )
    }
    const generation = requestedGeneration
    const refresh = Promise.resolve()
      .then(reader)
      .then((content) => {
        if (this.generation(key) === generation) {
          this.publishContent(key, content)
        }
        return this.read(key)
      })
      .catch((error: unknown) => {
        if (this.generation(key) === generation) {
          this.invalidate(key, error)
        }
        return this.read(key)
      })
      .finally(() => {
        if (this.inFlight.get(key)?.promise === refresh) {
          this.inFlight.delete(key)
        }
      })
    this.inFlight.set(key, { generation, promise: refresh })
    return refresh
  }

  remove(key: string): void {
    const removedGeneration = this.generation(key) + 1
    const inFlight = this.inFlight.get(key)
    this.entries.delete(key)
    this.inFlight.delete(key)
    if (!inFlight) {
      this.removedGenerations.delete(key)
      return
    }
    this.removedGenerations.set(key, removedGeneration)
    void inFlight.promise.finally(() => {
      if (
        !this.entries.has(key) &&
        !this.inFlight.has(key) &&
        this.removedGenerations.get(key) === removedGeneration
      ) {
        this.removedGenerations.delete(key)
      }
    })
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of new Set([...this.entries.keys(), ...this.inFlight.keys()])) {
      if (!keys.has(key)) {
        this.remove(key)
      }
    }
  }

  resetForTests(): void {
    this.entries.clear()
    this.inFlight.clear()
    this.removedGenerations.clear()
  }

  retainedRemovalGenerationCountForTests(): number {
    return this.removedGenerations.size
  }

  private generation(key: string): number {
    return this.entries.get(key)?.generation ?? this.removedGenerations.get(key) ?? 0
  }

  private parse(content: string | null): OrcaYamlSnapshotValue {
    if (content === null) {
      return {
        contentState: 'missing',
        hooks: null,
        mayNeedUpdate: false,
        sharedDirectories: []
      }
    }
    const inspection = inspectOrcaYaml(content)
    const hasUnknownKey = inspection.topLevelKeys.some((key) => !RECOGNIZED_KEYS.has(key))
    return {
      contentState: inspection.valid ? 'valid' : 'invalid',
      hooks: inspection.hooks,
      mayNeedUpdate: inspection.valid && inspection.hooks === null && hasUnknownKey,
      sharedDirectories: inspection.hooks?.worktree?.sharedDirectories ?? []
    }
  }
}

export const orcaYamlSnapshots = new OrcaYamlSnapshotStore()

export function refreshLocalOrcaYamlSnapshot(repoPath: string): Promise<OrcaYamlSnapshot> {
  return orcaYamlSnapshots.refresh(repoPath, async () => {
    try {
      return await readOrcaYamlThroughFilesystemHost(join(repoPath, 'orca.yaml'))
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }
      throw error
    }
  })
}

export function readLocalOrcaYamlSnapshot(repoPath: string): OrcaYamlSnapshot {
  const snapshot = orcaYamlSnapshots.read(repoPath)
  if (snapshot.stale || snapshot.age === null || snapshot.age >= SNAPSHOT_REVALIDATION_MS) {
    void refreshLocalOrcaYamlSnapshot(repoPath)
  }
  return snapshot
}

export async function readFreshLocalOrcaYamlSnapshot(repoPath: string): Promise<OrcaYamlSnapshot> {
  return await refreshLocalOrcaYamlSnapshot(repoPath)
}

export function seedLocalOrcaYamlSnapshot(
  repo: Pick<Repo, 'connectionId' | 'executionHostId' | 'kind' | 'path'>
): void {
  if (!isLocalSnapshotRepo(repo) || orcaYamlSnapshots.has(repo.path)) {
    return
  }
  void refreshLocalOrcaYamlSnapshot(repo.path)
}

function isLocalSnapshotRepo(
  repo: Pick<Repo, 'connectionId' | 'executionHostId' | 'kind' | 'path'>
): boolean {
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID && !isFolderRepo(repo)
}

export function reconcileLocalOrcaYamlSnapshots(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId' | 'kind' | 'path'>[]
): void {
  reconcileFilesystemHostFailureDomains(
    repos
      .filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
      .map((repo) => repo.path)
  )
  const paths = new Set(repos.filter(isLocalSnapshotRepo).map((repo) => repo.path))
  orcaYamlSnapshots.retain(paths)
  for (const repo of repos) {
    seedLocalOrcaYamlSnapshot(repo)
  }
}
