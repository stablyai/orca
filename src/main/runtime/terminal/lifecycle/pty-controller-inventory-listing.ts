import { OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController } from './pty-worktree-refresh'
import type * as PtyControllerContract from '../../runtime-pty-controller-contract'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import {
  type ExecutionHostId,
  getConnectionExecutionHostId
} from '../../../../shared/execution-host'
import {
  PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS,
  PTY_CONTROLLER_LIST_TIMEOUT_MS
} from '../../orca-runtime-postlude'
import { pruneOldestMapEntry } from '../../prune-oldest-map-entry'
import { withTimeoutResult } from '../../runtime-async-boundaries'

type HostScopedPtyProcesses = { processes: PtyProcessInfo[]; hostIds: ExecutionHostId[] }

export type PtyInventoryListing = HostScopedPtyProcesses & { stale: boolean }

export abstract class OrcaRuntimeWithPtyControllerInventoryListing extends OrcaRuntimeWithRefreshPtyWorktreeRecordsFromController {
  /** The newest aggregate listing, which a superseded targeted read joins instead of re-listing. */
  private latestAggregatePtyInventoryListing: {
    generation: number
    processes: Promise<HostScopedPtyProcesses>
    opts: { deadlineMs: number; includeForegroundProcessEvidence?: boolean }
  } | null = null

  /** Lists the controller's PTYs; `stale` means a newer listing or lifecycle change overtook it. */
  protected async listPtyControllerInventory(
    targeted: boolean,
    deadline: number | undefined,
    connectionId: string | null | undefined,
    inventoryOptions: PtyControllerContract.PtyInventoryRefreshOptions | undefined
  ): Promise<PtyInventoryListing | null> {
    const controller = this.ptyController
    if (!controller?.listProcesses) {
      return null
    }
    let generation = ++this.ptyControllerInventorySequence
    const providerKey = getConnectionExecutionHostId(connectionId)
    if (connectionId === undefined) {
      this.ptyControllerAggregateInventoryGeneration = generation
    } else {
      this.ptyControllerInventoryGenerationByProvider.set(providerKey, generation)
      pruneOldestMapEntry(this.ptyControllerInventoryGenerationByProvider, 512)
    }
    // Why one deadline: joining newer listings must not extend a deadline-free read without end.
    const overallDeadline = deadline ?? Date.now() + PTY_CONTROLLER_LIST_TIMEOUT_MS
    const listBudget = () =>
      Math.max(1, Math.min(PTY_CONTROLLER_LIST_TIMEOUT_MS, overallDeadline - Date.now()))
    const listBudgetMs = listBudget()
    const providerListOpts = {
      deadlineMs: Date.now() + Math.max(1, listBudgetMs - PTY_CONTROLLER_LIST_PROVIDER_MARGIN_MS),
      ...(inventoryOptions?.includeForegroundProcessEvidence === undefined
        ? {}
        : { includeForegroundProcessEvidence: inventoryOptions.includeForegroundProcessEvidence })
    }
    const processes =
      connectionId === undefined && controller.listProcessesWithHostScope
        ? controller.listProcessesWithHostScope(providerListOpts)
        : controller
            .listProcesses(connectionId === undefined ? undefined : providerKey, providerListOpts)
            .then((listed) => ({ processes: listed, hostIds: [providerKey] }))
    if (connectionId === undefined) {
      this.latestAggregatePtyInventoryListing = { generation, processes, opts: providerListOpts }
    }
    const isCurrent = () =>
      connectionId === undefined
        ? this.ptyControllerAggregateInventoryGeneration === generation &&
          ![...this.ptyControllerInventoryGenerationByProvider.values()].some(
            (provider) => provider > generation
          )
        : this.ptyControllerInventoryGenerationByProvider.get(providerKey) === generation &&
          this.ptyControllerAggregateInventoryGeneration <= generation
    let result = await withTimeoutResult(processes, listBudgetMs)
    // Why join: a census begun after ours is fresh enough, and re-listing would supersede it in turn.
    while (result.ok && targeted && connectionId === undefined && !isCurrent()) {
      const newer = this.latestAggregatePtyInventoryListing
      // Never another read's question: same evidence asked, and as long to wait for slow hosts.
      if (
        !newer ||
        newer.generation <= generation ||
        newer.opts.includeForegroundProcessEvidence !==
          providerListOpts.includeForegroundProcessEvidence ||
        newer.opts.deadlineMs < providerListOpts.deadlineMs
      ) {
        break
      }
      generation = newer.generation
      result = await withTimeoutResult(newer.processes, listBudget())
    }
    return result.ok ? { ...result.value, stale: !isCurrent() } : null
  }
}
