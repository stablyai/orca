import { basename, dirname, join, resolve } from 'node:path'
import {
  nativeSkillPathSemantics,
  skillPathInside,
  skillPathsEqual
} from '../../../shared/skill-path-containment'
import type { SkillInstallProviderId } from '../../../shared/skill-install-providers'
import type { ResolvedSkillInstallDestination } from '../skill-install-destinations'
import {
  resolveSkillProviderDestinations,
  type SkillProviderRootOverrides
} from '../skill-provider-destinations'
import type { BundledSkillFilesystem } from './filesystem'

/** One real skills folder; every skill gets one target in it. */
export type BundledSkillTargetRoot = {
  role: 'shared' | 'agent'
  /** Literal spelling: what locks key on and what the user sees. */
  path: string
  /** Real path, resolved through the nearest existing ancestor. */
  realPath: string
  agents: SkillInstallProviderId[]
}

export type BundledSkillTargetRequest = {
  /** Resolved by `resolveSkillInstallDestination` from the runtime's install authority. */
  destination: Pick<
    ResolvedSkillInstallDestination,
    'scope' | 'homeDirectory' | 'workspaceDirectory'
  >
  /** Detected or `--agent` agents; empty means the shared root only (`--agent universal`). */
  agents: readonly SkillInstallProviderId[]
  /** From `resolveSkillProviderRoots` (`CLAUDE_CONFIG_DIR`, `GROK_HOME`, Orca's Claude profile). */
  providerRootOverrides?: SkillProviderRootOverrides
}

export function bundledSkillPathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

/** Missing tails are re-attached, so a root not created yet still resolves through linked parents. */
export async function resolveBundledSkillRealPath(
  filesystem: BundledSkillFilesystem,
  path: string
): Promise<string> {
  const missing: string[] = []
  for (let current = resolve(path); ; current = dirname(current)) {
    const real = await filesystem.realpath(current)
    if (real !== null) {
      return join(real, ...missing.toReversed())
    }
    if (dirname(current) === current) {
      return resolve(path)
    }
    missing.push(basename(current))
  }
}

/**
 * The shared root first, then each agent root that is a different real folder. Two spellings
 * of one folder (`~/.claude/skills -> ~/.agents/skills`, a Claude profile linked to
 * `~/.claude/skills`) are one target, so it is never planned twice.
 */
export async function resolveBundledSkillTargets(
  request: BundledSkillTargetRequest,
  filesystem: BundledSkillFilesystem
): Promise<BundledSkillTargetRoot[]> {
  const { scope, homeDirectory, workspaceDirectory } = request.destination
  const scopeRoot = scope === 'global' ? homeDirectory : workspaceDirectory
  if (!scopeRoot) {
    throw new Error('skill-install-workspace-required')
  }
  const workspaceRealPath =
    scope === 'workspace' ? await resolveBundledSkillRealPath(filesystem, scopeRoot) : null
  const sharedPath = join(scopeRoot, '.agents', 'skills')
  const candidates: { role: 'shared' | 'agent'; path: string; agents: SkillInstallProviderId[] }[] =
    [{ role: 'shared', path: sharedPath, agents: [] }]
  for (const destination of resolveSkillProviderDestinations({
    scope,
    homeDirectory,
    ...(workspaceDirectory ? { workspaceDirectory } : {}),
    detectedProviders: request.agents,
    ...(request.providerRootOverrides
      ? { providerRootOverrides: request.providerRootOverrides }
      : {})
  })) {
    if (destination.readsCanonicalRoot) {
      candidates[0].agents.push(destination.provider)
      continue
    }
    // Why: like the skills CLI, a project only gets links in agent folders it already has.
    if (scope === 'workspace' && (await filesystem.realpath(destination.rootPath)) === null) {
      continue
    }
    candidates.push({ role: 'agent', path: destination.rootPath, agents: [destination.provider] })
  }

  const roots = new Map<string, BundledSkillTargetRoot>()
  const semantics = nativeSkillPathSemantics()
  for (const candidate of candidates) {
    const realPath = await resolveBundledSkillRealPath(filesystem, candidate.path)
    if (
      workspaceRealPath !== null &&
      !skillPathsEqual(workspaceRealPath, realPath, semantics) &&
      !skillPathInside(workspaceRealPath, realPath, semantics)
    ) {
      continue
    }
    const existing = roots.get(bundledSkillPathKey(realPath))
    if (existing) {
      existing.agents.push(...candidate.agents)
      continue
    }
    roots.set(bundledSkillPathKey(realPath), { ...candidate, realPath })
  }
  return [...roots.values()]
}
