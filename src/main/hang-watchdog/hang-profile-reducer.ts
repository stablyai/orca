import type { Profiler } from 'node:inspector'
import {
  hangLabel,
  hangModule,
  topHangStacks,
  type HangStacks,
  type HangFrame,
  type HangStack
} from './hang-stacks'

export function reduceHangProfile(profile: Profiler.Profile): HangStacks {
  const nodes = new Map<number, Profiler.ProfileNode>()
  const parents = new Map<number, number>()
  let edgeBudget = 20_000
  let truncated = profile.nodes.length > 10_000 || (profile.samples?.length ?? 0) > 100_000
  for (let i = 0; i < Math.min(profile.nodes.length, 10_000); i++) {
    const node = profile.nodes[i]
    nodes.set(node.id, node)
    for (const child of node.children ?? []) {
      if (parents.size >= 10_000 || edgeBudget-- <= 0) {
        truncated = true
        break
      }
      parents.set(child, node.id)
    }
  }
  const counts = new Map<number, number>()
  let validSamples = 0
  const samples = profile.samples ?? []
  for (let i = 0; i < Math.min(samples.length, 100_000); i++) {
    const id = samples[i]
    const frame = nodes.get(id)?.callFrame
    if (
      !frame ||
      ['(root)', '(idle)', '(program)', '(garbage collector)'].includes(frame.functionName)
    ) {
      continue
    }
    counts.set(id, (counts.get(id) ?? 0) + 1)
    validSamples++
  }
  const selected: { id: number; count: number }[] = []
  for (const [id, count] of counts) {
    if (selected.length === 3 && count <= selected[2].count) {
      continue
    }
    selected.push({ id, count })
    selected.sort((a, b) => b.count - a.count)
    selected.splice(3)
  }
  const top: HangStack[] = []
  for (const { id, count } of selected) {
    const frames: HangFrame[] = []
    const seen = new Set<number>()
    let current: number | undefined = id
    while (current !== undefined && frames.length < 8 && !seen.has(current)) {
      seen.add(current)
      const node = nodes.get(current)
      if (!node) {
        truncated = true
        break
      }
      const frame = node.callFrame
      if (!['(root)', '(idle)', '(program)'].includes(frame.functionName)) {
        frames.push({
          name: hangLabel(frame.functionName || '(anonymous)'),
          module: hangModule(frame.url),
          ...(frame.lineNumber >= 0 ? { line: frame.lineNumber + 1 } : {}),
          ...(frame.columnNumber >= 0 ? { column: frame.columnNumber + 1 } : {})
        })
      }
      current = parents.get(current)
    }
    const ranked = topHangStacks([...top, { frames, count, hot: false }], validSamples)
    top.splice(0, top.length, ...ranked)
  }
  return { stacks: top, samples: samples.length, validSamples, truncated }
}
