import { join } from 'node:path'
import type { BundledSkillOp } from '../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillSource } from './bundled-skill-sources'
import {
  hasCloudReceipt,
  hasPendingCloudTransaction,
  stateKeysFor
} from './bundled-skill-cloud-state'
import { classifyBundledSkillPath } from './bundled-skill-classification'
import type { BundledSkillPlanInput } from './bundled-skill-plan'
import {
  bundledSkillPathKey,
  linkPointsAt,
  resolveBundledSkillRealPath,
  type BundledSkillTargetRoot
} from './bundled-skill-targets'

/** Global roots Orca once installed into for agents that also read ~/.agents/skills. */
const FORMER_GLOBAL_SKILL_ROOTS: readonly (readonly string[])[] = [
  // Gemini CLI warns on every start when this repeats a ~/.agents/skills name.
  ['.gemini', 'skills']
]

/** Orca's own copies or links in former roots, retired once the shared copy is in place; a lone one moves there. */
export async function planFormerRootPlacements(
  context: {
    input: BundledSkillPlanInput
    roots: readonly BundledSkillTargetRoot[]
    source: BundledSkillSource
    digest: string
  },
  sharedRoot: BundledSkillTargetRoot
): Promise<NonNullable<BundledSkillOp['previous']>> {
  const { input, roots, source, digest } = context
  const { destination, filesystem, stateDirectory } = input
  if (sharedRoot.role !== 'shared' || destination.scope !== 'global') {
    return []
  }
  const targetKeys = new Set(roots.map((root) => bundledSkillPathKey(root.realPath)))
  const homeRealPath = await resolveBundledSkillRealPath(filesystem, destination.homeDirectory)
  const previous: NonNullable<BundledSkillOp['previous']>[number][] = []
  for (const segments of FORMER_GLOBAL_SKILL_ROOTS) {
    const root = join(destination.homeDirectory, ...segments)
    const path = join(root, source.name)
    const { folderClass, observed } = await classifyBundledSkillPath(
      filesystem,
      path,
      source,
      digest
    )
    if (observed.kind === 'absent' || observed.kind === 'unreadable') {
      continue
    }
    // Orca only made a plain folder here; a linked one, or one a target links to, is another root.
    const rootRealPath = await resolveBundledSkillRealPath(filesystem, root)
    if (
      bundledSkillPathKey(rootRealPath) !== bundledSkillPathKey(join(homeRealPath, ...segments)) ||
      targetKeys.has(bundledSkillPathKey(rootRealPath))
    ) {
      continue
    }
    const keys = stateKeysFor(path, join(rootRealPath, source.name))
    const owned =
      observed.kind === 'link'
        ? await linkPointsAt(
            filesystem,
            path,
            observed.target,
            join(sharedRoot.realPath, source.name)
          )
        : (folderClass === 'current' || folderClass === 'released') &&
          !(await hasCloudReceipt(stateDirectory, keys))
    if (
      owned &&
      !(await hasPendingCloudTransaction(stateDirectory, keys)) &&
      (await filesystem.canWrite(rootRealPath))
    ) {
      previous.push({ path, observed })
    }
  }
  return previous
}
