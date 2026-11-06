import { join } from 'node:path'
import type { BundledSkillInstallResult } from '../../../shared/bundled-skill-plan'
import { acquireSkillInstallLock, skillInstallLockPath } from '../skill-install-lock'
import type { BundledSkillExecuteInput } from './execute'
import { findBundledSkillSource } from './renamed-skill-placement'
import { bundledSkillPathKey, resolveBundledSkillTargets } from './targets'

/** Lock literal paths consistently with delete/cloud installs; sort to prevent deadlocks. */
async function lockPaths(input: BundledSkillExecuteInput): Promise<string[]> {
  const roots = await resolveBundledSkillTargets(input, input.filesystem)
  const selected = input.names
    ? input.names.map((name) => findBundledSkillSource(input.sources, name))
    : input.sources
  const names = selected.flatMap((source) => [source.name, ...(source.aliases ?? [])])
  return [
    ...new Map(
      roots.flatMap((root) =>
        names.map((name) => [bundledSkillPathKey(join(root.path, name)), join(root.path, name)])
      )
    )
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

export async function withBundledSkillTargetLocks(
  input: BundledSkillExecuteInput,
  unrun: (status: 'changed' | 'busy') => BundledSkillInstallResult,
  run: () => Promise<BundledSkillInstallResult>
): Promise<BundledSkillInstallResult> {
  let releases: (() => Promise<void>)[]
  try {
    releases = await acquireLocks(input, await lockPaths(input))
  } catch {
    return unrun('busy')
  }
  try {
    return await run()
  } finally {
    await releaseAll(releases)
  }
}
