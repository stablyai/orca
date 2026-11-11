import { join } from 'node:path'
import type { resolveSkillInstallDestination } from './skill-install-destinations'

export function canonicalRoot(input: {
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
}): string {
  const scopeRoot = input.scope === 'global' ? input.homeDirectory : input.workspaceDirectory
  if (!scopeRoot) {
    throw new Error('skill-install-workspace-required')
  }
  return join(scopeRoot, '.agents', 'skills')
}

export function canonicalPath(
  destination: Awaited<ReturnType<typeof resolveSkillInstallDestination>>,
  name: string
): string {
  return join(
    destination.scope === 'global' ? destination.homeDirectory : destination.workspaceDirectory!,
    '.agents',
    'skills',
    name
  )
}
