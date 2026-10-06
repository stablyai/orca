import { spawnSync } from 'node:child_process'

/**
 * Touches and keys for the iOS Simulator device attached to this worktree, through `orca emulator`.
 * Coordinates are fractions of the screen. A gesture point lasts about 16 ms.
 */
export type SimulatorInput = {
  tap: (x: number, y: number) => void
  type: (text: string) => void
  gesture: (points: GesturePoint[]) => void
  /** Every labelled element on screen, in accessibility order. */
  labelledElements: () => ScreenElement[]
}

export type ScreenElement = { label: string; x: number; y: number; width: number; height: number }

/** The element's label and frame when the node has both, read without asserting its shape. */
function screenElement(node: object): ScreenElement | null {
  if (!('label' in node) || !('frame' in node)) {
    return null
  }
  const { label, frame } = node
  if (typeof label !== 'string' || !label || typeof frame !== 'object' || frame === null) {
    return null
  }
  const number = (key: string): number => {
    const value: unknown = Object.entries(frame).find(([name]) => name === key)?.[1]
    return typeof value === 'number' ? value : 0
  }
  return { label, x: number('x'), y: number('y'), width: number('width'), height: number('height') }
}

function collectLabelled(node: unknown, found: ScreenElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collectLabelled(child, found))
    return
  }
  if (typeof node !== 'object' || node === null) {
    return
  }
  const element = screenElement(node)
  if (element) {
    found.push(element)
  }
  Object.values(node).forEach((child) => collectLabelled(child, found))
}

export type GesturePoint = { type: 'begin' | 'move' | 'end'; x: number; y: number }

export function simulatorInput(worktreeRoot: string): SimulatorInput {
  const emulator = (...args: string[]): string => {
    const result = spawnSync('orca', ['emulator', ...args, '--json'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      timeout: 30_000
    })
    if (result.status !== 0) {
      throw new Error(`orca emulator ${args[0]} failed: ${result.stderr || result.stdout}`)
    }
    return result.stdout
  }
  return {
    tap: (x, y) => emulator('tap', String(x), String(y)),
    type: (text) => emulator('type', text),
    gesture: (points) => emulator('gesture', '--points', JSON.stringify(points)),
    labelledElements: () => {
      const found: ScreenElement[] = []
      collectLabelled(JSON.parse(emulator('ax')), found)
      return found
    }
  }
}

/** One straight vertical stroke at mid-width; `steps` sets its duration and so its speed. */
export function verticalStroke(fromY: number, toY: number, steps: number): GesturePoint[] {
  const points: GesturePoint[] = [{ type: 'begin', x: 0.5, y: fromY }]
  for (let step = 1; step <= steps; step++) {
    points.push({ type: 'move', x: 0.5, y: fromY + ((toY - fromY) * step) / steps })
  }
  points.push({ type: 'end', x: 0.5, y: toY })
  return points
}
