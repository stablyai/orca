import { join } from 'node:path'
import type {
  BundledSkillCleanup,
  BundledSkillInstallResult,
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillOpOutcome,
  BundledSkillOutcome,
  BundledSkillPlanEntry
} from '../../../shared/bundled-skill-plan'
import { acquireSkillInstallLock, skillInstallLockPath } from '../skill-install-lock'
import type { BundledSkillSource } from './bundled-skill-sources'
import { classifyBundledSkillPath } from './classify'
import { filesystemErrorCode } from './filesystem'
import { buildBundledSkillPlan, sameBundledSkillObserved, type BundledSkillPlanInput } from './plan'
import {
  BundledSkillChangedError,
  backUpBundledSkillPath,
  bundledSkillBackupPath,
  putBundledSkillFolder,
  removeBundledSkillSibling,
  replaceBundledSkillPath,
  swapBundledSkillFolder
} from './swap'
import { bundledSkillPathKey, resolveBundledSkillTargets } from './targets'

export type BundledSkillExecuteInput = BundledSkillPlanInput & {
  /** Per-lock wait; the shared 5s default applies when unset. */
  lockTimeoutMs?: number
}

type SkillRun = {
  input: BundledSkillExecuteInput
  entry: BundledSkillPlanEntry
  source: BundledSkillSource
}

/** Literal target paths, as delete and cloud install key locks; sorted so two runs can't deadlock. */
async function lockPaths(input: BundledSkillExecuteInput): Promise<string[]> {
  const roots = await resolveBundledSkillTargets(input, input.filesystem)
  const names = input.names ?? input.sources.map((source) => source.name)
  return [
    ...new Map(
      roots.flatMap((root) =>
        names.map((name) => [bundledSkillPathKey(join(root.path, name)), join(root.path, name)])
      )
    ).entries()
  ]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([, path]) => path)
}

async function acquireLocks(
  input: BundledSkillExecuteInput,
  paths: readonly string[]
): Promise<(() => Promise<void>)[]> {
  const releases: (() => Promise<void>)[] = []
  try {
    for (const path of paths) {
      releases.push(
        await acquireSkillInstallLock({
          path: skillInstallLockPath(input.stateDirectory, path),
          ...(input.lockTimeoutMs === undefined ? {} : { timeoutMs: input.lockTimeoutMs })
        })
      )
    }
  } catch (error) {
    await releaseAll(releases)
    throw error
  }
  return releases
}

async function releaseAll(releases: readonly (() => Promise<void>)[]): Promise<void> {
  for (const release of releases.toReversed()) {
    await release().catch(() => undefined)
  }
}

function verifier(run: SkillRun, path: string, expected: BundledSkillObserved) {
  return async () =>
    sameBundledSkillObserved(
      (
        await classifyBundledSkillPath(
          run.input.filesystem,
          path,
          run.source,
          run.entry.digest,
          'treeDigest' in expected
        )
      ).observed,
      expected
    )
}

async function requireUnchanged(run: SkillRun, path: string, expected: BundledSkillObserved) {
  if (!(await verifier(run, path, expected)())) {
    throw new BundledSkillChangedError(path)
  }
}

function backupFor(run: SkillRun): string {
  return bundledSkillBackupPath(run.input.destination.homeDirectory, run.entry.name)
}

async function settleCleanup(run: SkillRun, cleanup: BundledSkillCleanup) {
  await requireUnchanged(run, cleanup.path, cleanup.observed)
  await (cleanup.action === 'delete'
    ? removeBundledSkillSibling(run.input.filesystem, cleanup.path)
    : backUpBundledSkillPath(run.input.filesystem, cleanup.path, backupFor(run)))
}

/** Re-hashes the copy an update moved aside: a writer that raced the lock keeps its bytes. */
async function settleOldCopy(run: SkillRun, old: string) {
  const { folderClass } = await classifyBundledSkillPath(
    run.input.filesystem,
    old,
    run.source,
    run.entry.digest
  )
  if (folderClass === 'current' || folderClass === 'released') {
    await removeBundledSkillSibling(run.input.filesystem, old)
    return undefined
  }
  return backUpBundledSkillPath(run.input.filesystem, old, backupFor(run))
}

function requireLinkTarget(op: BundledSkillOp): string {
  if (!op.linkTarget) {
    throw new Error('bundled-skill-link-without-target')
  }
  return op.linkTarget
}

/** Applies exactly the op `plan` chose; it never picks a different one. */
async function applyOp(run: SkillRun, op: BundledSkillOp): Promise<string | undefined> {
  const { filesystem } = run.input
  const files = [{ path: 'SKILL.md', text: run.source.text }]
  const verify = verifier(run, op.path, op.observed)
  for (const cleanup of op.cleanup) {
    await settleCleanup(run, cleanup)
  }
  switch (op.kind) {
    case 'keep':
    case 'leave':
      return undefined
    case 'write':
    case 'copy':
      await putBundledSkillFolder(filesystem, op.path, files, verify)
      return undefined
    case 'link':
      await requireUnchanged(run, op.path, op.observed)
      await filesystem.createLink(requireLinkTarget(op), op.path)
      return undefined
    case 'update': {
      const old = await swapBundledSkillFolder(filesystem, op.path, files, verify)
      // The new copy is in; a leftover old copy is the next plan's cleanup, not a failed update.
      return settleOldCopy(run, old).catch(() => undefined)
    }
    case 'replace': {
      const backupPath = backupFor(run)
      await replaceBundledSkillPath(
        filesystem,
        op.path,
        backupPath,
        op.content === 'link' ? { linkTarget: requireLinkTarget(op) } : { files },
        verify
      )
      return backupPath
    }
    case 'restore': {
      const from = op.restoreFrom
      if (!from) {
        throw new Error('bundled-skill-restore-without-source')
      }
      await requireUnchanged(run, from.path, from.observed)
      await requireUnchanged(run, op.path, op.observed)
      await filesystem.rename(from.path, op.path)
      return undefined
    }
  }
}

async function runSkill(run: SkillRun): Promise<BundledSkillOutcome> {
  const statuses = new Map<string, BundledSkillOpOutcome['status']>()
  const ops: BundledSkillOpOutcome[] = []
  for (const op of run.entry.ops) {
    const outcome: BundledSkillOpOutcome =
      op.requires && statuses.get(op.requires) !== 'done'
        ? { path: op.path, kind: op.kind, status: 'skipped' }
        : await applyOp(run, op).then(
            (backupPath) => ({
              path: op.path,
              kind: op.kind,
              status: 'done' as const,
              ...(op.reason ? { reason: op.reason } : {}),
              ...(backupPath ? { backupPath } : {})
            }),
            (error: unknown) =>
              error instanceof BundledSkillChangedError
                ? { path: op.path, kind: op.kind, status: 'changed' as const }
                : {
                    path: op.path,
                    kind: op.kind,
                    status: 'failed' as const,
                    error: filesystemErrorCode(error)
                  }
          )
    statuses.set(op.path, outcome.status)
    ops.push(outcome)
  }
  return { name: run.entry.name, status: 'ran', ops }
}

/**
 * Re-plans under every target's lock and runs only a plan that still hashes to `planDigest`;
 * any difference means the user previewed something else, so nothing is written.
 */
export async function executeBundledSkillPlan(
  input: BundledSkillExecuteInput,
  planDigest: string
): Promise<BundledSkillInstallResult> {
  const names = input.names ?? input.sources.map((source) => source.name)
  const unrun = (status: 'changed' | 'busy'): BundledSkillInstallResult => ({
    scope: input.destination.scope,
    skills: names.map((name) => ({ name, status, ops: [] }))
  })
  const paths = await lockPaths(input)
  let releases: (() => Promise<void>)[]
  try {
    releases = await acquireLocks(input, paths)
  } catch {
    return unrun('busy')
  }
  try {
    const { plan } = await buildBundledSkillPlan(input)
    if (plan.planDigest !== planDigest) {
      return unrun('changed')
    }
    const skills: BundledSkillOutcome[] = []
    for (const entry of plan.skills) {
      const source = input.sources.find((candidate) => candidate.name === entry.name)
      if (!source) {
        throw new Error(`bundled-skill-unknown: ${entry.name}`)
      }
      skills.push(await runSkill({ input, entry, source }))
    }
    return { scope: plan.scope, skills }
  } finally {
    await releaseAll(releases)
  }
}
