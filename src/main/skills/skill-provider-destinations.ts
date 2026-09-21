import { join, resolve } from 'node:path'
import {
  isSkillInstallProviderId,
  SKILL_INSTALL_PROVIDERS,
  type SkillInstallProviderId
} from '../../shared/skill-install-providers'

export type OrcaSkillProviderId = SkillInstallProviderId

export type SkillProviderDestination = {
  provider: OrcaSkillProviderId
  readsCanonicalRoot: boolean
  rootPath: string
}

export type SkillProviderRootOverrides = Partial<Record<OrcaSkillProviderId, string>>

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function resolveSkillProviderDestinations(input: {
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
  detectedProviders: readonly string[]
  providerRootOverrides?: SkillProviderRootOverrides
}): SkillProviderDestination[] {
  const detected = new Set(input.detectedProviders.filter(isSkillInstallProviderId))
  const scopeRoot = input.scope === 'global' ? input.homeDirectory : input.workspaceDirectory
  if (!scopeRoot) {
    throw new Error('skill-install-workspace-required')
  }
  const destinations: SkillProviderDestination[] = []
  const canonicalRoot = join(scopeRoot, '.agents', 'skills')
  const claimedPlacementRoots = new Set<string>()
  for (const provider of SKILL_INSTALL_PROVIDERS) {
    if (!detected.has(provider.id)) {
      continue
    }
    const segments = input.scope === 'global' ? provider.globalSegments : provider.workspaceSegments
    const overriddenRoot =
      input.scope === 'global' ? input.providerRootOverrides?.[provider.id] : undefined
    const rootPath = overriddenRoot
      ? overriddenRoot
      : segments
        ? join(scopeRoot, ...segments)
        : canonicalRoot
    const readsCanonicalRoot = normalizedPath(rootPath) === normalizedPath(canonicalRoot)
    if (!readsCanonicalRoot) {
      const normalizedRoot = normalizedPath(rootPath)
      if (claimedPlacementRoots.has(normalizedRoot)) {
        throw new Error('skill-install-provider-root-collision')
      }
      claimedPlacementRoots.add(normalizedRoot)
    }
    destinations.push({ provider: provider.id, readsCanonicalRoot, rootPath })
  }
  return destinations
}
