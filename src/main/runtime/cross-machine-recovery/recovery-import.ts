import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import {
  recoveryBindingKeyOf,
  recoveryBindingKeyString,
  selectRecoveryBinding,
  type RecoveryBindingSelector
} from '../../../shared/cross-machine-recovery-binding-key'
import type {
  RecoveryAgentBinding,
  RecoveryImportRequest,
  RecoveryImportResult,
  RecoveryProvenance
} from '../../../shared/cross-machine-recovery-descriptor'
import { recoveryImportDestination } from '../../../shared/cross-machine-recovery-session-ops'
import type { CrossMachineRecoveryImportParams } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import { OrcaRecoveryDescriptorV1Schema } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import { readRepoCommonDirFromGit } from '../../git/worktree-list-reader'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  computeRecoveryImportKey,
  planRecoveryImport,
  type RecoveryPlanContext
} from './recovery-import-plan'
import { replayRecoveryImport } from './recovery-import-replay'
import { resumeSelectedRecoveryBindings } from './recovery-resume'
import { applyRecoverySessionIdMap } from './recovery-session-id-map'
import type { CrossMachineRecoveryHost } from './recovery-runtime-host'

export type ReadGitCommonDir = (checkoutPath: string) => Promise<string | undefined>

async function canonicalCommonDir(read: ReadGitCommonDir, dir: string): Promise<string | null> {
  const commonDir = await read(dir).catch(() => undefined)
  return commonDir ? await realpath(path.resolve(dir, commonDir)).catch(() => null) : null
}

async function resolveRecoveryRepo(
  host: CrossMachineRecoveryHost,
  checkoutPath: string,
  registerRepo: boolean,
  read: ReadGitCommonDir
): Promise<string> {
  const commonDir = await canonicalCommonDir(read, checkoutPath)
  if (!commonDir) {
    throw new Error('recovery_repo_unregistered')
  }
  const repos = host.listLocalRepos()
  const commonDirs = await Promise.all(repos.map((repo) => canonicalCommonDir(read, repo.path)))
  const match = repos.find((_repo, index) => commonDirs[index] === commonDir)
  if (match) {
    return match.id
  }
  if (!registerRepo) {
    throw new Error('recovery_repo_unregistered')
  }
  const repoRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : checkoutPath
  return (await host.addRepo(repoRoot)).id
}

function resolveResumeKeys(
  bindings: readonly RecoveryAgentBinding[],
  selectors: readonly RecoveryBindingSelector[]
): Set<string> {
  return new Set(
    selectors.map((selector) => {
      const selection = selectRecoveryBinding(bindings, selector)
      if (!selection.ok) {
        throw new Error(selection.code)
      }
      return recoveryBindingKeyString(recoveryBindingKeyOf(selection.binding))
    })
  )
}

const importsInFlightByWorktree = new Map<string, Promise<unknown>>()

// Why: two identical first imports would both see an empty destination; the later one must
// find the earlier one's provenance and replay instead of failing as not empty.
async function serializedByWorktree<T>(worktreeId: string, run: () => Promise<T>): Promise<T> {
  const current = (importsInFlightByWorktree.get(worktreeId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(run)
  const settled = current.catch(() => undefined)
  importsInFlightByWorktree.set(worktreeId, settled)
  try {
    return await current
  } finally {
    if (importsInFlightByWorktree.get(worktreeId) === settled) {
      importsInFlightByWorktree.delete(worktreeId)
    }
  }
}

export async function importRecoveryWorkspaceWithHost(
  host: CrossMachineRecoveryHost,
  params: RecoveryImportRequest,
  readCommonDir: ReadGitCommonDir = readRepoCommonDirFromGit
): Promise<RecoveryImportResult> {
  const rekeyed = applyRecoverySessionIdMap(params.descriptor.bindings, params.sessionIdMap ?? [])
  const descriptor = { ...params.descriptor, bindings: rekeyed.bindings }
  const resumeKeys = resolveResumeKeys(descriptor.bindings, params.resume ?? [])
  const checkoutPath = await realpath(params.checkoutPath).catch(() => {
    throw new Error('recovery_checkout_missing')
  })
  const repoId = await resolveRecoveryRepo(
    host,
    checkoutPath,
    params.registerRepo === true,
    readCommonDir
  )
  host.invalidateWorktreeCatalog(repoId)
  const worktree = await host.resolveWorktree(`path:${checkoutPath}`)
  return await serializedByWorktree(worktree.id, () =>
    importIntoWorktree(host, params, {
      descriptor,
      sourceIds: rekeyed.sourceIds,
      resumeKeys,
      checkoutPath,
      repoId,
      worktree
    })
  )
}

async function importIntoWorktree(
  host: CrossMachineRecoveryHost,
  params: RecoveryImportRequest,
  {
    descriptor,
    sourceIds,
    resumeKeys,
    checkoutPath,
    repoId,
    worktree
  }: {
    descriptor: RecoveryImportRequest['descriptor']
    sourceIds: RecoveryPlanContext['sourceProviderSessionIds']
    resumeKeys: ReadonlySet<string>
    checkoutPath: string
    repoId: string
    worktree: { id: string; instanceId?: string }
  }
): Promise<RecoveryImportResult> {
  const meta = host.getWorktreeMeta(worktree.id)
  const instanceId = worktree.instanceId ?? meta?.instanceId
  if (!instanceId) {
    throw new Error('recovery_unsupported')
  }
  const importKey = computeRecoveryImportKey(descriptor)
  const now = host.now()
  const ctx: RecoveryPlanContext = {
    worktreeId: worktree.id,
    checkoutPath,
    sourceWorkspacePath: descriptor.workspace.path,
    now,
    mintId: host.mintId,
    importKey,
    pathMap: params.pathMap ?? [],
    sourceProviderSessionIds: sourceIds,
    recoveryLaunch: params.recoveryLaunch ?? {}
  }
  const session = host.getLocalSession()
  const prior = meta?.recoveryProvenance
  const base = { importKey, repoId, worktreeId: worktree.id, instanceId }

  const replay = { descriptor, ctx, resumeKeys, base, dryRun: params.dryRun === true }
  if (prior?.importKey === importKey) {
    return await replayRecoveryImport(host, { ...replay, provenance: prior })
  }
  const plan = planRecoveryImport(descriptor, params.preferClientInstanceId, ctx)
  const provenance: RecoveryProvenance = {
    importKey,
    checkpointId: params.checkpointId,
    importedAt: now,
    source: {
      runtimeId: descriptor.source.runtimeId,
      machineName: descriptor.source.machineName,
      platform: descriptor.source.platform,
      appVersion: descriptor.source.appVersion,
      worktreeId: descriptor.workspace.worktreeId,
      instanceId: descriptor.workspace.instanceId,
      path: descriptor.workspace.path,
      exportedAt: descriptor.exportedAt
    },
    presentationSource: plan.presentationSource
  }
  // Why: the layout write carries its importKey, so a crash before the provenance write replays.
  const finishLanded = async (): Promise<RecoveryImportResult> => {
    if (!params.dryRun) {
      await host.updateRecoveryProvenance(worktree.id, () => provenance)
    }
    return await replayRecoveryImport(host, { ...replay, provenance })
  }
  const destination = recoveryImportDestination(session, worktree.id, importKey)
  if (destination === 'occupied') {
    throw new Error('recovery_destination_not_empty')
  }
  if (destination === 'landed') {
    return await finishLanded()
  }
  const result = {
    ...base,
    disposition: 'imported' as const,
    presentationSource: plan.presentationSource,
    idMap: plan.idMap,
    provenance
  }
  if (params.dryRun) {
    return { ...result, bindings: plan.bindings.map((p) => p.result) }
  }
  const outcome = await host.applyOp({
    kind: 'import',
    importKey,
    fragment: plan.fragment,
    records: plan.bindings.flatMap((p) => (p.record ? [p.record] : []))
  })
  if (!outcome.ok) {
    throw new Error(outcome.code)
  }
  if (outcome.alreadyApplied) {
    return await finishLanded()
  }
  await host.updateRecoveryProvenance(worktree.id, () => provenance)
  const bindings = await resumeSelectedRecoveryBindings(
    host,
    worktree.id,
    plan.bindings,
    resumeKeys
  )
  if (params.activate) {
    await host.activateWorktree(worktree.id)
  }
  return { ...result, bindings }
}

export async function importRecoveryWorkspace(
  runtime: OrcaRuntimeService,
  params: z.infer<typeof CrossMachineRecoveryImportParams>
): Promise<RecoveryImportResult> {
  const descriptor = OrcaRecoveryDescriptorV1Schema.safeParse(params.descriptor)
  if (!descriptor.success) {
    throw new Error('recovery_descriptor_invalid')
  }
  return await importRecoveryWorkspaceWithHost(
    runtime.getCrossMachineRecoveryHost((repoPath) => runtime.addRepo(repoPath)),
    { ...params, descriptor: descriptor.data }
  )
}
