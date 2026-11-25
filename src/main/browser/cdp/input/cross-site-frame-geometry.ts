import { readRecord, settle, type GuestSessionCdpSender } from './guest-frame-input-sessions'

// Maps viewport points into a cross-site frame through its owner element's box and transform.

export type Point = { x: number; y: number }
/** The inverse of the frame element's transform: frame point = rows · (p - origin) - offset. */
export type FrameMapping = { origin: Point; xRow: Point; yRow: Point; offset: Point }

export function toFrame(frames: readonly FrameMapping[], point: Point): Point {
  return frames.reduce((at, mapping) => applyInverse(mapping, at), point)
}

function applyInverse({ origin, xRow, yRow, offset }: FrameMapping, point: Point): Point {
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  return {
    x: dx * xRow.x + dy * xRow.y - offset.x,
    y: dx * yRow.x + dy * yRow.y - offset.y
  }
}

function readQuad(model: Record<string, unknown> | null, key: string): Point[] | null {
  const quad: unknown = model?.[key]
  if (!Array.isArray(quad) || quad.length !== 8) {
    return null
  }
  const n = quad.filter((value): value is number => Number.isFinite(value))
  return n.length === 8 ? [0, 2, 4, 6].map((i) => ({ x: n[i], y: n[i + 1] })) : null
}

/** Invert the frame element's transform: its border quad is the affine image of its layout box. */
function frameMapping(model: Record<string, unknown> | null): FrameMapping | null {
  const content = readQuad(model, 'content')
  const border = readQuad(model, 'border')
  const width = model?.width
  const height = model?.height
  if (!content || !border || typeof width !== 'number' || typeof height !== 'number') {
    return null
  }
  const [origin, topRight, , bottomLeft] = border
  const ux = { x: topRight.x - origin.x, y: topRight.y - origin.y }
  const uy = { x: bottomLeft.x - origin.x, y: bottomLeft.y - origin.y }
  const det = ux.x * uy.y - uy.x * ux.y
  if (det === 0 || width <= 0 || height <= 0) {
    return null
  }
  const toBorderBox: FrameMapping = {
    origin,
    xRow: { x: (uy.y * width) / det, y: (-uy.x * width) / det },
    yRow: { x: (-ux.y * height) / det, y: (ux.x * height) / det },
    offset: { x: 0, y: 0 }
  }
  // The frame's viewport starts at the content box, inside the element's border and padding.
  return { ...toBorderBox, offset: applyInverse(toBorderBox, content[0]) }
}

/** The owner's mapping, and whether its session timed out instead of answering. */
export async function frameOwnerMapping(
  send: GuestSessionCdpSender,
  sessionId: string | undefined,
  backendNodeId: number
): Promise<{ timedOut: boolean; mapping: FrameMapping | null }> {
  const box = await settle(send('DOM.getBoxModel', { backendNodeId }, sessionId))
  return {
    timedOut: box.outcome === 'timeout',
    mapping: frameMapping(readRecord(box.outcome === 'ok' ? box.value : null, 'model'))
  }
}
