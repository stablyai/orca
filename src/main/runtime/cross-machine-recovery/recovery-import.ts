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
  RecoveryImportBindingResult,
  RecoveryImportRequest,
  RecoveryImportResult,
  RecoveryProvenance
} from '../../../shared/cross-machine-recovery-descriptor'
import {
  findRecoveryRecord,
  worktreeHasSessionTabs
} from '../../../shared/cross-machine-recovery-session-ops'
import type { CrossMachineRecoveryImportParams } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import { OrcaRecoveryDescriptorV1Schema } from '../../../shared/rpc-contract/cross-machine-recovery-params'
import { readRepoCommonDirFromGit } from '../../git/worktree-list-reader'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  computeRecoveryImportKey,
  localRecoveryBindingKey,
  planRecoveryBindings,
  planRecoveryImport,
  sourceProviderSessionId,
  type PlannedRecoveryBinding,
  type RecoveryPlanContext
} from './recovery-import-plan'
import { resumeClaimedRecoveryBinding } from './recovery-resume'
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

async function resumeSelected(
  host: CrossMachineRecoveryHost,
  worktreeId: string,
  planned: readonly PlannedRecoveryBinding[],
  resumeKeys: ReadonlySet<string>
): Promise<RecoveryImportBindingResult[]> {
  const results: RecoveryImportBindingResult[] = []
  for (const { binding, record, result } of planned) {
    if (!record || !resumeKeys.has(recoveryBindingKeyString(recoveryBindingKeyOf(binding)))) {
      results.push(result)
      continue
    }
    try {
      const resumed = await resumeClaimedRecoveryBinding(
        host,
        worktreeId,
        recoveryBindingKeyOf(record),
        {
          launchPreferences: binding.launch.launchPreferences
        }
      )
      results.push({
        ...result,
        localPaneKey: resumed.localPaneKey,
        status: 'resumed',
        terminalHandle: resumed.terminalHandle
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Why: a failed launch restores the record, so the binding stays dormant rather than lost.
      const status = reason === 'recovery_session_live_locally' ? 'refused' : 'dormant'
      results.push({ ...result, status, reason })
    }
  }
  return results
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
    sourceProviderSessionIds: rekeyed.sourceIds
  }
  const session = host.getLocalSession()
  const prior = meta?.recoveryProvenance
  const base = { importKey, repoId, worktreeId: worktree.id, instanceId }

  if (prior?.importKey === importKey) {
    const records = session.sleepingAgentSessionsByPaneKey
    const fresh = descriptor.bindings.filter(
      (binding) =>
        !findRecoveryRecord(records, worktree.id, localRecoveryBindingKey(binding, ctx.pathMap))
    )
    const emptyIdMap = { tabs: {}, groups: {}, leaves: {}, browsers: {} }
    const freshPlans = new Map(
      planRecoveryBindings(fresh, { terminalLayoutsByTabId: {}, idMap: emptyIdMap }, ctx).map(
        (plan) => [recoveryBindingKeyString(recoveryBindingKeyOf(plan.binding)), plan]
      )
    )
    const planned = descriptor.bindings.map((binding): PlannedRecoveryBinding => {
      const localKey = localRecoveryBindingKey(binding, ctx.pathMap)
      const existing = findRecoveryRecord(records, worktree.id, localKey)
      const result = {
        sourcePaneKey: binding.sourcePaneKey,
        binding: localKey,
        sourceProviderSessionId: sourceProviderSessionId(binding, ctx),
        localPaneKey: existing?.paneKey ?? ''
      }
      if (existing) {
        return { binding, record: existing, result: { ...result, status: 'dormant' } }
      }
      // Why: a replay never adds a dormant twin beside a session this host already runs.
      if (host.isProviderSessionLive(localKey)) {
        return {
          binding,
          record: null,
          result: { ...result, status: 'refused', reason: 'recovery_session_live_locally' }
        }
      }
      const plan = freshPlans.get(recoveryBindingKeyString(recoveryBindingKeyOf(binding)))
      if (!plan) {
        throw new Error('recovery_binding_not_found')
      }
      return plan
    })
    if (!params.dryRun) {
      await host.applyOp({
        kind: 'merge-records',
        records: [...freshPlans.values()].flatMap((p) =>
          p.record && !host.isProviderSessionLive(recoveryBindingKeyOf(p.record)) ? [p.record] : []
        )
      })
    }
    return {
      ...base,
      disposition: 'replayed',
      presentationSource: prior.presentationSource,
      idMap: emptyIdMap,
      bindings: params.dryRun
        ? planned.map((p) => p.result)
        : await resumeSelected(host, worktree.id, planned, resumeKeys),
      provenance: prior
    }
  }

  if (worktreeHasSessionTabs(session, worktree.id)) {
    throw new Error('recovery_destination_not_empty')
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
    fragment: plan.fragment,
    records: plan.bindings.flatMap((p) => (p.record ? [p.record] : []))
  })
  if (!outcome.ok) {
    throw new Error(outcome.code)
  }
  await host.setRecoveryProvenance(worktree.id, provenance)
  const bindings = await resumeSelected(host, worktree.id, plan.bindings, resumeKeys)
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
