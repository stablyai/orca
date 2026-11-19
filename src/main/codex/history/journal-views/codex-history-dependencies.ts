import type {
  CodexHistoryObservedTurn,
  CodexHistoryObservation,
  HistoryAnchor
} from './codex-history-source-facts'
import { retainedSize } from './codex-history-workspace'

export function resolveHistoryDependencies(input: {
  target: CodexHistoryObservedTurn
  parents: ReadonlyMap<string, string | null>
  prior: ReadonlyMap<string, CodexHistoryObservation | undefined>
  source: ReadonlyMap<string, { key: string }>
  refusedInvocations: ReadonlySet<string>
  charge: (delta: number) => void
  savedParent: (id: string) => HistoryAnchor | null
}) {
  const { target, parents, prior, source, refusedInvocations, charge, savedParent } = input
  const missing: string[] = []
  const children = new Map<string, string[]>()
  const calls = new Set([
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'webSearch',
    'collabAgentToolCall'
  ])
  for (const [key, parent] of parents) {
    const observation = target.items.get(key)
    if (!observation || parent === null) {
      continue
    }
    const candidate = source.get(parent)
    const acceptedParent = candidate ? target.items.get(candidate.key) : undefined
    const anchor = !refusedInvocations.has(parent) && !acceptedParent ? savedParent(parent) : null
    if (
      refusedInvocations.has(parent) ||
      (acceptedParent
        ? !calls.has(acceptedParent.item.type)
        : !anchor || !['tool-call', 'diff'].includes(anchor.saved.body.kind))
    ) {
      missing.push(key)
    } else if (candidate && acceptedParent) {
      observation.parent = candidate.key
      const siblings = children.get(candidate.key) ?? []
      siblings.push(key)
      children.set(candidate.key, siblings)
    } else if (anchor) {
      observation.anchors.push(anchor)
      const extra = retainedSize([anchor.key, anchor.saved.itemId, anchor.saved.revision], null)
      charge(extra)
      observation.bytes += extra
    }
  }
  // Refuse this source's dependent observation, retaining any earlier valid observation.
  const refused = new Set<string>()
  for (let i = 0; i < missing.length; i++) {
    const key = missing[i]!
    if (refused.has(key)) {
      continue
    }
    refused.add(key)
    const observation = target.items.get(key),
      old = prior.get(key)
    if (observation) {
      charge(-observation.bytes)
    }
    if (old) {
      target.items.set(key, old)
    } else {
      target.items.delete(key)
    }
    missing.push(...(children.get(key) ?? []))
  }
}
