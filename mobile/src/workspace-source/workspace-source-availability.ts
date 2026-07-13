import { MOBILE_WORKSPACE_SOURCE_SELECTOR_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type {
  NewWorkspaceSourceFilter,
  WorkspaceSourceAvailability
} from './new-workspace-source-types'

export function supportsMobileWorkspaceSourceSelector(
  capabilities: readonly string[] | null | undefined
): boolean {
  return capabilities?.includes(MOBILE_WORKSPACE_SOURCE_SELECTOR_RUNTIME_CAPABILITY) === true
}

export function getWorkspaceSourceAvailability(args: {
  capabilities: readonly string[] | null | undefined
  repoKind?: 'git' | 'folder'
  repoConnected: boolean
  linearConnected: boolean
}): WorkspaceSourceAvailability {
  if (!supportsMobileWorkspaceSourceSelector(args.capabilities)) {
    return { github: false, branches: false, linear: false }
  }
  const repoScoped = args.repoKind !== 'folder' && args.repoConnected
  return {
    github: repoScoped,
    branches: repoScoped,
    linear: args.linearConnected
  }
}

export function hasWorkspaceSourceAvailability(availability: WorkspaceSourceAvailability): boolean {
  return availability.github || availability.branches || availability.linear
}

export function getAvailableWorkspaceSourceFilters(
  availability: WorkspaceSourceAvailability
): NewWorkspaceSourceFilter[] {
  return [
    'all',
    ...(availability.github ? (['github'] as const) : []),
    ...(availability.branches ? (['branches'] as const) : []),
    ...(availability.linear ? (['linear'] as const) : [])
  ]
}
