import { readRecord, settle, type GuestSessionCdpSender } from './guest-frame-input-sessions'

// Maps viewport points into a cross-site frame through its owner element's box and transform.

export type Point = { x: number; y: number }
type Row = readonly [number, number, number]
type Matrix = readonly [Row, Row, Row]
/** The inverse of the frame element's projection: frame point = rows · (p, 1), dehomogenized, - offset. */
export type FrameMapping = { rows: Matrix; offset: Point }

export function toFrame(frames: readonly FrameMapping[], point: Point): Point {
  return frames.reduce((at, mapping) => applyInverse(mapping, at), point)
}

const MIN_W = 1e-6

function applyInverse({ rows: [rx, ry, rw], offset }: FrameMapping, { x, y }: Point): Point {
  // Past the plane's horizon w turns negative; clamping keeps a captured drag heading off the frame.
  const w = Math.max(rw[0] * x + rw[1] * y + rw[2], MIN_W)
  return {
    x: (rx[0] * x + rx[1] * y + rx[2]) / w - offset.x,
    y: (ry[0] * x + ry[1] * y + ry[2]) / w - offset.y
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

/** The projective map of the unit square onto a quad given clockwise from its top-left corner. */
function squareToQuad([p0, p1, p2, p3]: Point[]): Matrix {
  const sx = p0.x - p1.x + p2.x - p3.x
  const sy = p0.y - p1.y + p2.y - p3.y
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const den = dx1 * dy2 - dx2 * dy1
  // Both are 0 for a parallelogram, which leaves an affine map.
  const g = (sx * dy2 - dx2 * sy) / den
  const h = (dx1 * sy - sx * dy1) / den
  return [
    [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x],
    [p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y],
    [g, h, 1]
  ]
}

function invert([a, b, c]: Matrix): Matrix | null {
  const det =
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    a[1] * (b[0] * c[2] - b[2] * c[0]) +
    a[2] * (b[0] * c[1] - b[1] * c[0])
  if (!Number.isFinite(det) || det === 0) {
    return null
  }
  return [
    [
      (b[1] * c[2] - b[2] * c[1]) / det,
      (a[2] * c[1] - a[1] * c[2]) / det,
      (a[1] * b[2] - a[2] * b[1]) / det
    ],
    [
      (b[2] * c[0] - b[0] * c[2]) / det,
      (a[0] * c[2] - a[2] * c[0]) / det,
      (a[2] * b[0] - a[0] * b[2]) / det
    ],
    [
      (b[0] * c[1] - b[1] * c[0]) / det,
      (a[1] * c[0] - a[0] * c[1]) / det,
      (a[0] * b[1] - a[1] * b[0]) / det
    ]
  ]
}

/** Invert the frame element's transform: its border quad is the projection of its layout box. */
function frameMapping(model: Record<string, unknown> | null): FrameMapping | null {
  const content = readQuad(model, 'content')
  const border = readQuad(model, 'border')
  const width = model?.width
  const height = model?.height
  if (!content || !border || typeof width !== 'number' || typeof height !== 'number') {
    return null
  }
  // A perspective transform moves all four corners independently, so all four fix the map.
  const toSquare = width > 0 && height > 0 ? invert(squareToQuad(border)) : null
  if (!toSquare) {
    return null
  }
  // w is 1 at the top-left corner and positive across the frame.
  const [rx, ry, rw] = toSquare
  const toBorderBox: FrameMapping = {
    rows: [
      [rx[0] * width, rx[1] * width, rx[2] * width],
      [ry[0] * height, ry[1] * height, ry[2] * height],
      rw
    ],
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
