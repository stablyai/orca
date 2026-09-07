import type { BrowserSnapshotRef } from '../../shared/runtime-types'
import { walkTree, type AXNode, type SnapshotEntry } from './snapshot-ax-tree-walk'
import { findCursorInteractiveElements } from './snapshot-cursor-interactive-elements'

export type CdpCommandSender = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>

export type RefEntry = {
  backendDOMNodeId: number
  role: string
  name: string
  sessionId?: string
  // Why: when multiple elements share the same role+name, nth tracks which
  // occurrence this ref represents (1-indexed). Used during stale ref recovery
  // to disambiguate duplicates.
  nth?: number
}

export type SnapshotResult = {
  snapshot: string
  refs: BrowserSnapshotRef[]
  refMap: Map<string, RefEntry>
}

export async function buildSnapshot(
  sendCommand: CdpCommandSender,
  iframeSessions?: Map<string, string>,
  makeIframeSender?: (sessionId: string) => CdpCommandSender
): Promise<SnapshotResult> {
  await sendCommand('Accessibility.enable')
  const { nodes } = (await sendCommand('Accessibility.getFullAXTree')) as { nodes: AXNode[] }

  const nodeById = new Map<string, AXNode>()
  for (const node of nodes) {
    nodeById.set(node.nodeId, node)
  }

  const entries: SnapshotEntry[] = []
  let refCounter = 1

  const root = nodes[0]
  if (!root) {
    return { snapshot: '', refs: [], refMap: new Map() }
  }

  walkTree(root, nodeById, 0, entries, () => refCounter++)

  // Why: many modern SPAs use styled <div>s, <span>s, and custom elements as
  // interactive controls without proper ARIA roles. These elements are invisible
  // to the accessibility tree walk above but are clearly interactive (cursor:pointer,
  // onclick, tabindex, contenteditable). This DOM query pass discovers them and
  // promotes them to interactive refs so the agent can interact with them.
  const cursorInteractiveEntries = await findCursorInteractiveElements(sendCommand, entries)
  for (const cie of cursorInteractiveEntries) {
    cie.ref = `@e${refCounter++}`
    entries.push(cie)
  }

  // Why: cross-origin iframes have their own AX trees accessible only through
  // their dedicated CDP session. Append their elements after the parent tree
  // so the agent can see and interact with iframe content.
  const iframeRefSessions: { ref: string; sessionId: string }[] = []
  if (iframeSessions && makeIframeSender && iframeSessions.size > 0) {
    for (const [_frameId, sessionId] of iframeSessions) {
      try {
        const iframeSender = makeIframeSender(sessionId)
        await iframeSender('Accessibility.enable')
        const { nodes: iframeNodes } = (await iframeSender('Accessibility.getFullAXTree')) as {
          nodes: AXNode[]
        }
        if (iframeNodes.length === 0) {
          continue
        }
        const iframeNodeById = new Map<string, AXNode>()
        for (const n of iframeNodes) {
          iframeNodeById.set(n.nodeId, n)
        }
        const iframeRoot = iframeNodes[0]
        if (iframeRoot) {
          const startRef = refCounter
          walkTree(iframeRoot, iframeNodeById, 1, entries, () => refCounter++)
          for (let i = startRef; i < refCounter; i++) {
            iframeRefSessions.push({ ref: `@e${i}`, sessionId })
          }
        }
      } catch {
        // Iframe session may be stale — skip silently
      }
    }
  }

  const refMap = new Map<string, RefEntry>()
  const refs: BrowserSnapshotRef[] = []
  const lines: string[] = []

  // Why: when multiple elements share the same role+name (e.g. 3 "Submit"
  // buttons), the agent can't distinguish them from text alone. Appending a
  // disambiguation suffix like "(2nd)" lets the agent refer to duplicates.
  const nameCounts = new Map<string, number>()
  const nameOccurrence = new Map<string, number>()
  for (const entry of entries) {
    if (entry.ref) {
      const key = `${entry.role}:${entry.name}`
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
    }
  }

  for (const entry of entries) {
    const indent = '  '.repeat(entry.depth)
    if (entry.ref) {
      const key = `${entry.role}:${entry.name}`
      const total = nameCounts.get(key) ?? 1
      let displayName = entry.name
      const nth = (nameOccurrence.get(key) ?? 0) + 1
      nameOccurrence.set(key, nth)
      if (total > 1 && nth > 1) {
        displayName = `${entry.name} (${ordinal(nth)})`
      }
      lines.push(`${indent}[${entry.ref}] ${entry.role} "${displayName}"`)
      refs.push({ ref: entry.ref, role: entry.role, name: displayName })
      const iframeSession = iframeRefSessions.find((s) => s.ref === entry.ref)
      refMap.set(entry.ref, {
        backendDOMNodeId: entry.backendDOMNodeId,
        role: entry.role,
        name: entry.name,
        sessionId: iframeSession?.sessionId,
        nth: total > 1 ? nth : undefined
      })
    } else {
      lines.push(`${indent}${entry.role} "${entry.name}"`)
    }
  }

  return { snapshot: lines.join('\n'), refs, refMap }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}
