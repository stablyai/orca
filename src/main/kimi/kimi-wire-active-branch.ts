import { parseJsonObject } from '../ai-vault/parsing/session-json-object'
import { asRecord } from '../ai-vault/parsing/session-record-fields'

type SwitchEdge = { line: number; branch: string; base: { branch: string; line: number } }

const MAIN_BRANCH = 'main'

/** Kimi records `/undo` as an `agent.switched` record that starts a new branch from an earlier
 *  line, leaving the undone records in place; the conversation is the last branch's chain. Lines
 *  are numbered as Kimi numbers them: every record, from 1. */
export function createKimiActiveBranch() {
  const edges: SwitchEdge[] = []
  let lastLine = 0
  return {
    /** Numbers the next record; call once per record, in file order. */
    number(line: string): number {
      lastLine++
      if (line.includes('"agent.switched"')) {
        const edge = readSwitchEdge(line, lastLine)
        if (edge) {
          edges.push(edge)
        }
      }
      return lastLine
    },
    /** Whether a line is on the conversation's chain; a chain Kimi could not walk keeps every line,
     *  as do lines appended after the ones numbered, which continue the last branch. */
    onActiveChain(): (line: number) => boolean {
      const ranges = activeChainRanges(edges, lastLine)
      const numbered = lastLine
      return ranges ? (line) => line > numbered || inRanges(ranges, line) : () => true
    }
  }
}

function readSwitchEdge(line: string, lineNumber: number): SwitchEdge | null {
  const record = parseJsonObject(line)
  const base = asRecord(record?.base)
  if (
    record?.type !== 'agent.switched' ||
    typeof record.branch !== 'string' ||
    typeof base?.branch !== 'string' ||
    typeof base.line !== 'number'
  ) {
    return null
  }
  return { line: lineNumber, branch: record.branch, base: { branch: base.branch, line: base.line } }
}

/** The chain's lines as ascending, disjoint ranges. Null when a base names no branch or loops,
 *  where Kimi itself refuses the chain. */
function activeChainRanges(edges: SwitchEdge[], lastLine: number): [number, number][] | null {
  if (edges.length === 0) {
    return null
  }
  const segments = new Map<string, { edge?: SwitchEdge; toLine: number }>()
  let branch = MAIN_BRANCH
  let opening: SwitchEdge | undefined
  for (const edge of edges) {
    segments.set(branch, { edge: opening, toLine: edge.line })
    branch = edge.branch
    opening = edge
  }
  segments.set(branch, { edge: opening, toLine: lastLine })
  const ranges: [number, number][] = []
  const visited = new Set<string>()
  let name = branch
  let upto: number | undefined
  for (;;) {
    const segment = segments.get(name)
    if (!segment || visited.has(name)) {
      return null
    }
    visited.add(name)
    ranges.push([segment.edge ? segment.edge.line + 1 : 1, upto ?? segment.toLine])
    if (!segment.edge) {
      return mergedRanges(ranges)
    }
    name = segment.edge.base.branch
    upto = segment.edge.base.line
  }
}

// A base line may reach past its own segment, so ranges can overlap; the chain is their union.
function mergedRanges(ranges: [number, number][]): [number, number][] {
  const merged: [number, number][] = []
  for (const [floor, ceil] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && floor <= last[1] + 1) {
      last[1] = Math.max(last[1], ceil)
    } else if (floor <= ceil) {
      merged.push([floor, ceil])
    }
  }
  return merged
}

function inRanges(ranges: [number, number][], line: number): boolean {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [floor, ceil] = ranges[middle]
    if (line < floor) {
      high = middle - 1
    } else if (line > ceil) {
      low = middle + 1
    } else {
      return true
    }
  }
  return false
}
