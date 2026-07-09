import type { UISlice } from '@/store/slices/ui'

export type MainSurface = 'activity' | 'creation' | 'landing' | null

export type MainSurfaceInput = {
  activeView: UISlice['activeView']
  activeWorktreeId: string | null
  creationLayoutActive: boolean
}

export function resolveMainSurface({
  activeView,
  activeWorktreeId,
  creationLayoutActive
}: MainSurfaceInput): MainSurface {
  // Why: creation and Agents share the same content slot, so creation wins
  // while its layout is active instead of mounting both surfaces.
  if (creationLayoutActive && (activeView === 'terminal' || activeView === 'activity')) {
    return 'creation'
  }

  if (activeView === 'activity') {
    return 'activity'
  }

  if (activeView === 'terminal' && activeWorktreeId === null) {
    return 'landing'
  }

  return null
}
