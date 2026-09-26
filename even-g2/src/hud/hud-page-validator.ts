// Client-side twin of the SDK's validateEvenHubPageContainer (spec S5). Called by
// hud-render-queue before every bridge call; violations are never sent to firmware.
import type { HudContainerSpec, HudPageBuild, HudTextUpgrade } from '../glasses/glasses-bridge'

const MAX_TEXT_LIST_CONTAINERS = 8
const MAX_TOTAL_CONTAINERS = 12
const MAX_CONTAINER_NAME_CHARS = 16
const MAX_TEXT_CHARS = 1000
const MAX_UPGRADE_TEXT_CHARS = 2000
const MAX_LIST_ITEMS = 20
const MAX_LIST_ITEM_CHARS = 64
const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288

export type HudPageViolation =
  | { code: 'too-many-containers'; count: number } // >8 text/list or >12 total
  | { code: 'event-capture-count'; count: number } // !== 1
  | { code: 'duplicate-container-id' | 'duplicate-container-name'; value: string }
  | { code: 'container-name-too-long'; name: string } // >16
  | { code: 'text-too-long'; id: number; length: number } // >1000
  | { code: 'list-item-limit'; id: number; count: number } // >20 items or item >64 chars
  | { code: 'geometry-out-of-bounds'; id: number }

function isOutOfBounds(c: HudContainerSpec): boolean {
  return (
    c.x < 0 ||
    c.y < 0 ||
    c.width <= 0 ||
    c.height <= 0 ||
    c.x + c.width > CANVAS_WIDTH ||
    c.y + c.height > CANVAS_HEIGHT
  )
}

export function validateHudPage(page: HudPageBuild): HudPageViolation[] {
  const violations: HudPageViolation[] = []
  const { containers } = page

  // Every container in this contract is text/list (no image kind), so the tighter
  // 8-container limit is the binding one; the 12-total ceiling is documented headroom.
  if (containers.length > MAX_TEXT_LIST_CONTAINERS || containers.length > MAX_TOTAL_CONTAINERS) {
    violations.push({ code: 'too-many-containers', count: containers.length })
  }

  const captureCount = containers.filter((c) => c.isEventCapture === 1).length
  if (captureCount !== 1) {
    violations.push({ code: 'event-capture-count', count: captureCount })
  }

  const seenIds = new Set<number>()
  const seenNames = new Set<string>()
  for (const c of containers) {
    if (seenIds.has(c.id)) {
      violations.push({ code: 'duplicate-container-id', value: String(c.id) })
    }
    seenIds.add(c.id)

    if (seenNames.has(c.name)) {
      violations.push({ code: 'duplicate-container-name', value: c.name })
    }
    seenNames.add(c.name)

    if (c.name.length > MAX_CONTAINER_NAME_CHARS) {
      violations.push({ code: 'container-name-too-long', name: c.name })
    }

    if (c.kind === 'text' && c.content.length > MAX_TEXT_CHARS) {
      violations.push({ code: 'text-too-long', id: c.id, length: c.content.length })
    }

    if (c.kind === 'list') {
      // Spec S4: list containers take 1-20 items; 0 is as invalid as >20.
      const outOfRange = c.items.length === 0 || c.items.length > MAX_LIST_ITEMS
      const overItemLength = c.items.some((item) => item.length > MAX_LIST_ITEM_CHARS)
      if (outOfRange || overItemLength) {
        violations.push({ code: 'list-item-limit', id: c.id, count: c.items.length })
      }
    }

    if (isOutOfBounds(c)) {
      violations.push({ code: 'geometry-out-of-bounds', id: c.id })
    }
  }

  return violations
}

/** Twin check for `upgradeText` payloads (spec S5): they bypass buildHudPage's own truncation,
 * so validate the wire-level limits directly before every upgrade call. */
export function validateHudTextUpgrade(update: HudTextUpgrade): HudPageViolation[] {
  const violations: HudPageViolation[] = []
  if (update.name.length > MAX_CONTAINER_NAME_CHARS) {
    violations.push({ code: 'container-name-too-long', name: update.name })
  }
  if (update.content.length > MAX_UPGRADE_TEXT_CHARS) {
    violations.push({ code: 'text-too-long', id: update.id, length: update.content.length })
  }
  return violations
}
