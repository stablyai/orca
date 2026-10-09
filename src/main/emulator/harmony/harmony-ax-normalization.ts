import type { NormalizedAxFrame, NormalizedAxNode } from '../serve-sim-ax-normalization'

// Normalizes a uitest dumpLayout tree into the same compact shape as iOS/Android
// ax trees, with frames in 0..1 coordinates so agents can feed positions straight
// back into tap/gesture.

const MAX_AX_NODES = 500

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// bounds: "[x1,y1][x2,y2]".
export function parseBounds(value: unknown): NormalizedAxFrame | null {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(asString(value))
  if (!match) {
    return null
  }
  const x1 = Number(match[1])
  const y1 = Number(match[2])
  const x2 = Number(match[3])
  const y2 = Number(match[4])
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function normalizeFrame(frame: NormalizedAxFrame, screen: NormalizedAxFrame): NormalizedAxFrame {
  return {
    x: round4((frame.x - screen.x) / screen.width),
    y: round4((frame.y - screen.y) / screen.height),
    width: round4(frame.width / screen.width),
    height: round4(frame.height / screen.height)
  }
}

function normalizeNode(
  raw: unknown,
  screen: NormalizedAxFrame,
  budget: { remaining: number }
): NormalizedAxNode | null {
  const node = asRecord(raw)
  const attributes = asRecord(node.attributes)
  const frame = parseBounds(attributes.bounds)
  if (!frame) {
    return null
  }

  budget.remaining -= 1
  const rawChildren = Array.isArray(node.children) ? node.children : []
  const children: NormalizedAxNode[] = []
  for (const child of rawChildren) {
    if (budget.remaining <= 0) {
      break
    }
    const normalizedChild = normalizeNode(child, screen, budget)
    if (normalizedChild) {
      children.push(normalizedChild)
    }
  }

  const type = asString(attributes.type)
  const normalized: NormalizedAxNode = {
    role: asString(attributes.description) || type,
    type,
    label: asString(attributes.text) || asString(attributes.description),
    value: asString(attributes.text),
    enabled: attributes.enabled !== 'false',
    frame: normalizeFrame(frame, screen),
    children
  }
  const id = asString(attributes.id)
  if (id) {
    normalized.id = id
  }
  if (children.length < rawChildren.length) {
    normalized.truncated = true
  }
  return normalized
}

export function normalizeHarmonyAxTree(root: unknown): NormalizedAxNode[] {
  const screen = parseBounds(asRecord(asRecord(root).attributes).bounds) ?? {
    x: 0,
    y: 0,
    width: 1,
    height: 1
  }
  if (screen.width <= 0 || screen.height <= 0) {
    return []
  }
  const normalized = normalizeNode(root, screen, { remaining: MAX_AX_NODES })
  return normalized ? [normalized] : []
}
