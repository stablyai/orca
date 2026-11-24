import { join, resolve } from 'node:path'
import type { BundledSkillOp } from '../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillSource } from './bundled-skill-sources'
import {
  hasCloudReceipt,
  hasPendingCloudTransaction,
  stateKeysFor
} from './bundled-skill-cloud-state'
import { classifyBundledSkillPath } from './bundled-skill-classification'
import type { BundledSkillPlanInput } from './bundled-skill-plan'
import { recoverySiblings } from './bundled-skill-swap-recovery'
import { isOtherBuildCopy } from './bundled-skill-written-digests'
import { bundledSkillPathKey, type BundledSkillTargetRoot } from './bundled-skill-targets'

export async function planFormerSkillPlacements(
  input: BundledSkillPlanInput,
  root: BundledSkillTargetRoot,
  source: BundledSkillSource,
  digest: string,
  sharedRoot: BundledSkillTargetRoot | undefined
): Promise<{
  installed: boolean
  previous: NonNullable<BundledSkillOp['previous']>
  leaves: BundledSkillOp[]
}> {
  const previous: NonNullable<BundledSkillOp['previous']>[number][] = []
  const leaves: BundledSkillOp[] = []
  let installed = false
  const { filesystem, stateDirectory } = input
  const releasedTarget = async (path: string): Promise<boolean> => {
    const realPath = await filesystem.realpath(path)
    if (!realPath || (await hasCloudReceipt(stateDirectory, stateKeysFor(path, realPath)))) {
      return false
    }
    const target = await classifyBundledSkillPath(filesystem, realPath, source, digest)
    return target.folderClass === 'current' || target.folderClass === 'released'
  }
  for (const name of source.aliases ?? []) {
    const path = join(root.path, name)
    const keys = stateKeysFor(path, join(root.realPath, name))
    const classified = await classifyBundledSkillPath(filesystem, path, source, digest)
    const { observed } = classified
    if (observed.kind === 'absent') {
      continue
    }
    let owned = classified.folderClass === 'released' || classified.folderClass === 'current'
    const linkedRealPath = observed.kind === 'link' ? await filesystem.realpath(path) : null
    const canonical = bundledSkillPathKey(join(root.realPath, source.name))
    // Junctions store an absolute spelling (linked home, subst drive), so also compare realpaths.
    const forwarding =
      observed.kind === 'link' &&
      (bundledSkillPathKey(resolve(root.realPath, observed.target)) === canonical ||
        (linkedRealPath !== null && bundledSkillPathKey(linkedRealPath) === canonical))
    if (observed.kind === 'link' && sharedRoot) {
      const target = linkedRealPath ?? resolve(root.realPath, observed.target)
      const formerShared = join(sharedRoot.realPath, name)
      const sharedTarget = (await filesystem.realpath(join(sharedRoot.path, name))) ?? formerShared
      if (bundledSkillPathKey(target) === bundledSkillPathKey(sharedTarget)) {
        owned = await releasedTarget(join(sharedRoot.path, name))
      }
    }
    if (forwarding) {
      owned = await releasedTarget(join(root.path, source.name))
    }
    const cloud = await hasCloudReceipt(stateDirectory, keys)
    if (cloud) {
      owned = false
    }
    installed ||= owned || (!cloud && classified.folderClass === 'edited')
    const reason = (await hasPendingCloudTransaction(stateDirectory, keys))
      ? 'busy'
      : owned && !(await filesystem.canWrite(root.realPath))
        ? 'unwritable'
        : null
    if (!owned || reason) {
      leaves.push({
        path,
        role: root.role,
        agents: root.agents,
        observed,
        kind: 'leave',
        cleanup: [],
        reason:
          reason ??
          (observed.kind === 'unreadable'
            ? 'unreadable'
            : classified.folderClass !== 'edited'
              ? 'other'
              : // A build from before the rename recorded these bytes under the former name.
                !cloud &&
                  (await isOtherBuildCopy(
                    filesystem,
                    input.destination,
                    { name, releasedDigests: source.releasedDigests },
                    observed
                  ))
                ? 'other-build'
                : 'edited')
      })
      continue
    }
    if (root.role === 'shared' && forwarding) {
      continue
    }
    previous.push({
      path,
      observed,
      ...(root.role === 'shared'
        ? filesystem.supportsLinks
          ? { forward: true }
          : { retain: true }
        : {})
    })
  }
  for (const name of source.aliases ?? []) {
    const path = join(root.path, name)
    const classified = await classifyBundledSkillPath(filesystem, path, source, digest)
    const recovery = await recoverySiblings(
      filesystem,
      { ...source, name },
      digest,
      root,
      classified.observed.kind === 'absent'
    )
    if (recovery.restoreFrom || recovery.cleanup.length) {
      installed = true
      const keys = stateKeysFor(path, join(root.realPath, name))
      const reason = (await hasPendingCloudTransaction(stateDirectory, keys))
        ? 'busy'
        : !(await filesystem.canWrite(root.realPath))
          ? 'unwritable'
          : null
      leaves.push({
        path,
        role: root.role,
        agents: root.agents,
        observed: classified.observed,
        ...(reason
          ? { kind: 'leave', reason, cleanup: [] }
          : { kind: recovery.restoreFrom ? 'restore' : 'keep', ...recovery })
      })
    }
  }
  return { installed, previous, leaves }
}

/**
 * Beside a kept copy, a former-name folder that is not this skill is the user's own, not a blocker.
 * Beside a copy holding an agent's files, a stale former copy stays listed so the user decides on it.
 */
export function formerLeavesBesideKeep(
  leaves: BundledSkillOp[],
  besideAgentFiles: boolean
): BundledSkillOp[] {
  return leaves.filter(
    (stale) => stale.reason !== 'other' && (besideAgentFiles || stale.reason !== 'edited')
  )
}
