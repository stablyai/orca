// Upgrade-vs-rebuild decision (spec S5). Measured costs: rebuild ~165ms flat,
// upgrade ~83ms per container -> break-even at 2, hence the <=2 text-change cap.
import type { HudContainerSpec, HudPageBuild, HudTextUpgrade } from '../glasses/glasses-bridge'

export type HudRenderPlan =
  | { kind: 'create'; page: HudPageBuild }
  | { kind: 'rebuild'; page: HudPageBuild }
  | { kind: 'upgrade'; updates: HudTextUpgrade[] } // length 1..2
  | { kind: 'noop' }

function skeletonEqual(a: HudContainerSpec, b: HudContainerSpec): boolean {
  if (
    a.kind !== b.kind ||
    a.id !== b.id ||
    a.name !== b.name ||
    a.x !== b.x ||
    a.y !== b.y ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.isEventCapture !== b.isEventCapture
  ) {
    return false
  }
  // List containers are not upgradable in place: any item change forces a rebuild.
  if (a.kind === 'list' && b.kind === 'list') {
    return a.items.length === b.items.length && a.items.every((item, i) => item === b.items[i])
  }
  return true
}

export function planHudRender(
  previous: HudPageBuild | null,
  next: HudPageBuild,
  startupSpent: boolean
): HudRenderPlan {
  if (previous === null || !startupSpent) {
    return { kind: 'create', page: next }
  }

  const prevContainers = previous.containers
  const nextContainers = next.containers
  if (prevContainers.length !== nextContainers.length) {
    return { kind: 'rebuild', page: next }
  }

  const sameSkeleton = prevContainers.every((c, i) => {
    const other = nextContainers[i]
    return other !== undefined && skeletonEqual(c, other)
  })
  if (!sameSkeleton) {
    return { kind: 'rebuild', page: next }
  }

  const updates: HudTextUpgrade[] = []
  for (let i = 0; i < nextContainers.length; i++) {
    const prevC = prevContainers[i]
    const nextC = nextContainers[i]
    if (prevC?.kind === 'text' && nextC?.kind === 'text' && prevC.content !== nextC.content) {
      updates.push({ id: nextC.id, name: nextC.name, content: nextC.content })
    }
  }

  if (updates.length === 0) {
    return { kind: 'noop' }
  }
  if (updates.length <= 2) {
    return { kind: 'upgrade', updates }
  }
  return { kind: 'rebuild', page: next }
}
