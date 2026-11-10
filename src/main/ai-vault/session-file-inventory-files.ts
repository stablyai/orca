import { SessionObservationRetries } from './session-observation-retries'
import type { FileWithMtime } from './session-scanner-types'
import { observeSessionFile, type DiscoverSessionFilesArgs } from './session-scanner-discovery'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { recordSessionScanIssue } from './session-scan-issues'
import { retainRecentSessionFile } from './session-file-observation'
import { sidecarEnrichesWithoutReparse } from './parse-cache/session-scanner-sidecar-enrichment'
import { sidecarUnchanged } from './parse-cache/session-sidecar-stat'

export type SessionFileChange = { file: FileWithMtime; force: boolean }

/** Accepted file facts and retry debt survive both directory epochs and delivered events. */
export class SessionInventoryFiles {
  readonly files = new Map<string, FileWithMtime>()
  readonly dependencies = new Map<string, Set<string>>()
  readonly failures = new SessionObservationRetries()
  readonly changes = new Map<string, SessionFileChange>()
  readonly removed = new Set<string>()
  readonly recent = new Map<string, FileWithMtime>()
  private readonly dependencyByFile = new Map<string, string>()
  constructor(
    private readonly addFile: (path: string) => void,
    private readonly scheduleParent: (path: string) => void,
    private readonly forgetDirty: (path: string) => void
  ) {}
  async observe(
    path: string,
    args: DiscoverSessionFilesArgs,
    force: boolean,
    limit: number,
    readOwed = false
  ) {
    if (!this.failures.mayAttempt(path)) {
      return
    }
    force ||= this.failures.force(path)
    const previous = this.files.get(path)
    const observation = await observeSessionFile(
      path,
      args.contentDependencyPath,
      args.signal,
      !force && previous ? { file: previous, path: this.dependencyByFile.get(path) } : undefined
    )
    throwIfAiVaultScanCancelled(args.signal)
    if ('issue' in observation) {
      if (observation.missing && !this.files.has(path)) {
        this.failures.delete(path)
        return
      }
      if (!observation.missing) {
        recordSessionScanIssue(args.issues, { agent: args.agent, ...observation.issue })
      }
      this.failures.fail(
        path,
        force || readOwed,
        observation.missing ? undefined : { agent: args.agent, ...observation.issue }
      )
      // Only apparent absence needs a parent membership proof.
      if (observation.missing) {
        this.scheduleParent(path)
      }
      return
    }
    const file = {
      ...observation.file,
      modifiedAt: new Date(observation.file.mtimeMs).toISOString()
    }
    const metadataOnly = sidecarEnrichesWithoutReparse({
      agent: args.agent,
      file,
      codexHome: null
    })
    if (!metadataOnly && observation.file.sidecar === 'unknown') {
      this.failures.fail(path, force || readOwed)
      file.sidecar = previous?.sidecar ?? 'unknown'
    } else {
      this.failures.delete(path)
    }
    const old = this.files.get(path)
    const dependency = metadataOnly ? undefined : observation.sidecarPath
    const previousDependency = this.dependencyByFile.get(path)
    if (previousDependency !== dependency) {
      if (previousDependency) {
        this.removeDependency(previousDependency, path)
      }
      if (dependency) {
        const owners = this.dependencies.get(dependency) ?? new Set<string>()
        owners.add(path)
        this.dependencies.set(dependency, owners)
        this.dependencyByFile.set(path, dependency)
      } else {
        this.dependencyByFile.delete(path)
      }
    }
    const dependencyChanged =
      !metadataOnly &&
      !!old &&
      file.sidecar !== 'unknown' &&
      !sidecarUnchanged(old.sidecar ?? 'none', file.sidecar ?? 'none')
    this.files.set(path, file)
    if (!old) {
      this.addFile(path)
    }
    if (
      force ||
      !old ||
      dependencyChanged ||
      old.mtimeMs !== file.mtimeMs ||
      old.sizeBytes !== file.sizeBytes ||
      old.dev !== file.dev ||
      old.ino !== file.ino
    ) {
      this.changes.set(path, {
        file,
        force:
          dependencyChanged ||
          (force &&
            !!old &&
            old.mtimeMs === file.mtimeMs &&
            old.sizeBytes === file.sizeBytes &&
            old.dev === file.dev &&
            old.ino === file.ino)
      })
    }
    retainRecentSessionFile(this.recent, file, limit)
    return !metadataOnly && observation.file.sidecar === 'unknown' ? undefined : file
  }

  forget(path: string): void {
    this.files.delete(path)
    this.failures.delete(path)
    this.forgetDirty(path)
    this.recent.delete(path)
    const dependency = this.dependencyByFile.get(path)
    if (dependency) {
      this.removeDependency(dependency, path)
    }
    this.dependencyByFile.delete(path)
    this.changes.delete(path)
    this.removed.add(path)
  }

  private removeDependency(dependency: string, path: string): void {
    const owners = this.dependencies.get(dependency)
    owners?.delete(path)
    if (!owners?.size) {
      this.dependencies.delete(dependency)
    }
  }
}
