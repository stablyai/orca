import type { SessionSearchPreparedObservation } from '../ai-vault-search/session-search-observation-types'
import type { SessionInventoryFiles } from './session-file-inventory-files'
import { SessionInventoryDirectoryWalks } from './session-file-inventory-walk'
import { dirname } from 'node:path'
import { wslGatedStat } from '../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from './scan-lifecycle/ai-vault-scan-cancellation'
import {
  isMissingTranscriptPathError,
  type DiscoverSessionFilesArgs
} from './discovery/session-scanner-discovery'
import { isInsideSessionRoot } from './discovery/session-file-discovery'

type DirtyInput = { path: string; force: boolean; dirtyRevision: number }
type Probe = {
  input: DirtyInput
  serial: number
  generation?: number
  revision?: number
  result?: { directory: boolean } | { error: unknown }
  phase: number
  valid?: boolean
}

/** A successful probe retains its next handoff across catalog failures. */
export class SessionInventoryDirtyInputs extends SessionInventoryDirectoryWalks {
  async observeForRead(
    path: string,
    args: DiscoverSessionFilesArgs,
    limit: number,
    metadataOnly = false,
    metadataOwed = false,
    dependencyOwners?: { scope: string; key: string }[],
    prepared?: SessionSearchPreparedObservation
  ) {
    return this.observations.readForIndex(
      path,
      args,
      limit,
      metadataOnly,
      metadataOwed,
      dependencyOwners,
      prepared
    )
  }

  readPreparation(...args: Parameters<SessionInventoryFiles['readPreparation']>) {
    return this.observations.readPreparation(...args)
  }
  private probeSequence = 0
  private probe: Probe | undefined
  protected releaseProbe(): void {
    this.probe = undefined
  }
  protected async completeReactivation(): Promise<void> {
    await this.request({ kind: 'authority-open', scope: this.scope, root: this.root })
    await this.observations.resume(0)
    const probe = this.probe
    if (!probe) {
      return
    }
    if (probe.revision === undefined) {
      probe.revision = (
        await this.request({
          kind: 'authority-probe',
          scope: this.scope,
          path: probe.input.path,
          receipt: { consumer: 'dirty-probe:begin', revision: probe.serial }
        })
      ).observationEpoch!
    }
    await this.request({
      kind: 'authority-probe-end',
      scope: this.scope,
      path: probe.input.path,
      revision: probe.revision,
      receipt: { consumer: 'dirty-probe:end', revision: probe.serial }
    })
    this.probe = undefined
  }
  protected get dirtyProbing(): boolean {
    return this.probe !== undefined
  }
  protected async drainDirty(args: DiscoverSessionFilesArgs, limit: number): Promise<void> {
    if (this.probe) {
      await this.finishProbe(args)
    }
    const page = await this.request({ kind: 'dirty-page', scope: this.scope })
    const inputs = page.dirtyInputs ?? []
    await this.observations.observePage(
      inputs.filter(({ path }) => this.accepts(path, args)),
      args,
      limit
    )
    for (const input of inputs) {
      if (this.accepts(input.path, args)) {
        continue
      }
      if (!isInsideSessionRoot(this.root, input.path)) {
        await this.acknowledgeDirty(input)
        continue
      }
      this.probe = { input, serial: ++this.probeSequence, phase: 0 }
      await this.finishProbe(args)
    }
  }
  private acknowledgeDirty(input: DirtyInput): Promise<unknown> {
    return this.request({
      kind: 'dirty-ack',
      scope: this.scope,
      path: input.path,
      revision: input.dirtyRevision
    })
  }
  private async finishProbe(args: DiscoverSessionFilesArgs): Promise<void> {
    const probe = this.probe!
    const { path } = probe.input
    const receipt = (phase: string) => ({
      consumer: `dirty-probe:${phase}`,
      revision: probe.serial
    })
    if (probe.revision === undefined) {
      probe.revision = (
        await this.request({
          kind: 'authority-probe',
          scope: this.scope,
          path,
          receipt: receipt('begin')
        })
      ).observationEpoch!
    }
    if (!probe.result) {
      probe.generation = this.failures.epoch
      try {
        const stat = await wslGatedStat(path, 'scan', args.signal)
        probe.result = { directory: stat.isDirectory() }
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        probe.result = { error }
      }
    }
    if (probe.valid === undefined) {
      probe.valid = !(
        await this.request({
          kind: 'authority-probe-end',
          scope: this.scope,
          path,
          revision: probe.revision,
          receipt: receipt('end')
        })
      ).invalidProof
    }
    if (probe.valid) {
      if ('error' in probe.result) {
        if (isMissingTranscriptPathError(probe.result.error)) {
          if (probe.phase === 0) {
            await this.schedule(path, false, true, probe.revision, receipt('missing'))
            probe.phase = 1
          }
          if (probe.phase === 1) {
            await this.schedule(dirname(path), false, false, undefined, receipt('parent'))
            probe.phase = 2
          }
        } else if (probe.phase === 0) {
          await this.issue(path, probe.result.error, args, {
            generation: probe.generation!,
            receipt: receipt('issue')
          })
          probe.phase = 2
        }
      } else {
        if (probe.phase === 0) {
          await this.failures.delete(path)
          probe.phase = 1
        }
        if (probe.phase === 1 && probe.result.directory) {
          await this.request({
            kind: 'directory-schedule',
            scope: this.scope,
            path,
            depth: this.depth(path),
            reconcile: false,
            trailing: true,
            receipt: receipt('schedule')
          })
          probe.phase = 2
        } else if (probe.phase === 1) {
          if (await this.directories.get(path)) {
            await this.schedule(dirname(path), false, false, undefined, receipt('parent'))
          }
          probe.phase = 2
        }
      }
    }
    await this.acknowledgeDirty(probe.input)
    this.probe = undefined
  }
  private depth(path: string): number {
    let depth = 0,
      key = path
    while (key !== this.root && dirname(key) !== key) {
      depth++
      key = dirname(key)
    }
    return depth
  }
}
