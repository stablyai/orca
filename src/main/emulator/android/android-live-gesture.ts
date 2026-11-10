import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

const GESTURE_DURATION_MS = 300
const GESTURE_STEP_MS = 16

/** Subdivide sparse paths so Android sees continuous motion through intermediate points. */
function gestureSamples(points: EmulatorGesturePoint[]): { x: number; y: number }[] {
  const segments = points.length - 1
  const stepsPerSegment = Math.max(1, Math.ceil(GESTURE_DURATION_MS / GESTURE_STEP_MS / segments))
  const samples = [{ x: points[0].x, y: points[0].y }]
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    for (let step = 1; step <= stepsPerSegment; step += 1) {
      const t = step / stepsPerSegment
      samples.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  return samples
}

/** Preserves intermediate path points; false tells the caller to fall back when live input fails. */
export async function sendAndroidLiveGesture(
  send: (phase: EmulatorGesturePoint['type'], x: number, y: number) => boolean,
  points: EmulatorGesturePoint[],
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  if (points.length < 2) {
    return true
  }
  const samples = gestureSamples(points)
  const first = samples[0]
  if (!send('begin', first.x, first.y)) {
    return false
  }
  for (let index = 1; index < samples.length; index += 1) {
    await sleep(GESTURE_STEP_MS)
    const sample = samples[index]
    const phase = index === samples.length - 1 ? 'end' : 'move'
    if (!send(phase, sample.x, sample.y)) {
      return false
    }
  }
  return true
}
