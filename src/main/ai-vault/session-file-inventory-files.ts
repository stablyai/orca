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
  readonly failures = new Map<string, boolean>()
  readonly changes = new Map<string, SessionFileChange>()
  readonly removed = new Set<string>()
  readonly recent = new Map<string, FileWithMtime>()
  private readonly dependencyByFile = new Map<string, string>()
  constructor(
    private readonly addFile: (path: string) => void,
    private readonly scheduleParent: (path: string) => void,
    private readonly forgetDirty: (path: string) => void
  ) {}
  async observe(path: string, args: DiscoverSessionFilesArgs, force: boolean, limit: number) {
    const observation = await observeSessionFile(
      path,
      !force && this.dependencyByFile.has(path)
        ? () => this.dependencyByFile.get(path)
        : args.contentDependencyPath,
      args.signal
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
      this.failures.set(path, force || (this.failures.get(path) ?? false))
      // A successful parent listing, never a refused stat, can remove membership.
      this.scheduleParent(path)
      return
    }
    const metadataOnly = sidecarEnrichesWithoutReparse({
      agent: args.agent,
      file: observation.file,
      codexHome: null
    })
    this.failures.delete(path)
    if (!metadataOnly && observation.file.sidecar === 'unknown') {
      this.failures.set(path, force)
    }
    const file = {
      ...observation.file,
      modifiedAt: new Date(observation.file.mtimeMs).toISOString()
    }
    const old = this.files.get(path)
    const dependency = metadataOnly ? undefined : observation.sidecarPath
    const previous = this.dependencyByFile.get(path)
    if (previous !== dependency) {
      if (previous) {
        this.removeDependency(previous, path)
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
