// Normalize pixel frames against the first root's screen frame for reuse in tap/gesture commands.

export type NormalizedAxFrame = { x: number; y: number; width: number; height: number }

// Matches serve-sim's own snapshot cap; an unbounded tree can flood agent output.
const MAX_AX_NODES = 500

export type NormalizedAxNode = {
  role: string
  type: string
  label: string
  value: string
  enabled: boolean
  id?: string
  frame: NormalizedAxFrame
  children: NormalizedAxNode[]
  // Present when children were dropped by the node cap.
  truncated?: true
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readFrame(value: unknown): NormalizedAxFrame {
  const frame = asRecord(value)
  return {
    x: numeric(frame.x),
    y: numeric(frame.y),
    width: numeric(frame.width),
    height: numeric(frame.height)
  }
}

// Fall back to a unit screen so a malformed/empty root never divides by zero.
function screenFrame(roots: unknown[]): NormalizedAxFrame {
  const first = readFrame(asRecord(roots[0]).frame)
  return first.width > 0 && first.height > 0 ? first : { x: 0, y: 0, width: 1, height: 1 }
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
): NormalizedAxNode {
  budget.remaining -= 1
  const node = asRecord(raw)
  const rawChildren = Array.isArray(node.children) ? node.children : []
  const children: NormalizedAxNode[] = []
  for (const child of rawChildren) {
    if (budget.remaining <= 0) {
      break
    }
    children.push(normalizeNode(child, screen, budget))
  }
  const normalized: NormalizedAxNode = {
    role: asString(node.role_description),
    type: asString(node.type),
    label: asString(node.AXLabel),
    value: asString(node.AXValue),
    enabled: node.enabled !== false,
    frame: normalizeFrame(readFrame(node.frame), screen),
    children
  }
  const uniqueId = asString(node.AXUniqueId)
  if (uniqueId) {
    normalized.id = uniqueId
  }
  if (children.length < rawChildren.length) {
    normalized.truncated = true
  }
  return normalized
}

export function normalizeServeSimAxTree(roots: unknown[]): NormalizedAxNode[] {
  const screen = screenFrame(roots)
  const budget = { remaining: MAX_AX_NODES }
  const normalized: NormalizedAxNode[] = []
  for (const root of roots) {
    if (budget.remaining <= 0) {
      break
    }
    normalized.push(normalizeNode(root, screen, budget))
  }
  return normalized
}
