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
    /** The record's line number; call once per record, in file order. */
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
    /** Whether a line is on the conversation's chain; a chain Kimi could not walk keeps every line. */
    onActiveChain(): (line: number) => boolean {
      const ranges = activeChainRanges(edges, lastLine)
      return ranges
        ? (line) => ranges.some(([floor, ceil]) => line >= floor && line <= ceil)
        : () => true
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
  const walk = (name: string, upto: number | undefined): boolean => {
    const segment = segments.get(name)
    if (!segment || visited.has(name)) {
      return false
    }
    visited.add(name)
    if (segment.edge && !walk(segment.edge.base.branch, segment.edge.base.line)) {
      return false
    }
    ranges.push([segment.edge ? segment.edge.line + 1 : 1, upto ?? segment.toLine])
    return true
  }
  return walk(branch, undefined) ? ranges : null
}
