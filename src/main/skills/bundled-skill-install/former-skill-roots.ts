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
import {
  bundledSkillPathKey,
  linkPointsAt,
  resolveBundledSkillRealPath,
  type BundledSkillTargetRoot
} from './bundled-skill-targets'

/** Global roots Orca once installed into for agents that also read ~/.agents/skills. */
const FORMER_GLOBAL_SKILL_ROOTS: readonly (readonly string[])[] = [
  // Orca once linked skills here for Gemini CLI; its copies still need retiring.
  ['.gemini', 'skills']
]

/** Retiring writes in these roots, so installs lock them like targets. */
export function formerSkillRootPaths(
  destination: Pick<BundledSkillPlanInput['destination'], 'scope' | 'homeDirectory'>
): string[] {
  return destination.scope === 'global'
    ? FORMER_GLOBAL_SKILL_ROOTS.map((segments) => join(destination.homeDirectory, ...segments))
    : []
}

/** Orca only made a plain folder here; a linked one, or one a target links to, is another root. */
async function plainFormerRootRealPath(
  input: BundledSkillPlanInput,
  roots: readonly BundledSkillTargetRoot[],
  segments: readonly string[]
): Promise<string | null> {
  const { destination, filesystem } = input
  const home = await resolveBundledSkillRealPath(filesystem, destination.homeDirectory)
  const realPath = await resolveBundledSkillRealPath(
    filesystem,
    join(destination.homeDirectory, ...segments)
  )
  const key = bundledSkillPathKey(realPath)
  return key === bundledSkillPathKey(join(home, ...segments)) &&
    !roots.some((root) => bundledSkillPathKey(root.realPath) === key)
    ? realPath
    : null
}

/** A target agent's link through this placement would dangle once it is retired. */
async function linkedFromTarget(
  input: BundledSkillPlanInput,
  roots: readonly BundledSkillTargetRoot[],
  name: string,
  paths: readonly string[]
): Promise<boolean> {
  const keys = new Set(paths.map(bundledSkillPathKey))
  for (const root of roots) {
    const link = join(root.path, name)
    if (root.role === 'shared' || (await input.filesystem.stat(link))?.kind !== 'symlink') {
      continue
    }
    const target = await input.filesystem.readLink(link)
    if (target !== null && keys.has(bundledSkillPathKey(resolve(root.realPath, target)))) {
      return true
    }
  }
  return false
}

/** Orca's copies or links under any of the skill's names, retired once the shared copy is in place. */
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
  const previous: NonNullable<BundledSkillOp['previous']>[number][] = []
  for (const segments of FORMER_GLOBAL_SKILL_ROOTS) {
    const root = join(destination.homeDirectory, ...segments)
    let rootRealPath: string | null | undefined
    for (const name of [source.name, ...(source.aliases ?? [])]) {
      const path = join(root, name)
      const { folderClass, observed } = await classifyBundledSkillPath(
        filesystem,
        path,
        source,
        digest
      )
      if (observed.kind === 'absent' || observed.kind === 'unreadable') {
        continue
      }
      rootRealPath ??= await plainFormerRootRealPath(input, roots, segments)
      if (!rootRealPath) {
        break
      }
      const keys = stateKeysFor(path, join(rootRealPath, name))
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
        !(await linkedFromTarget(input, roots, name, [path, join(rootRealPath, name)])) &&
        !(await hasPendingCloudTransaction(stateDirectory, keys)) &&
        (await filesystem.canWrite(rootRealPath))
      ) {
        previous.push({ path, observed })
      }
    }
  }
  return previous
}
