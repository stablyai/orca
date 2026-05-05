/* eslint-disable max-lines -- Why: snapshot building, AX tree walking, ref mapping, and cursor-interactive detection are tightly coupled and belong in one module. */
import type { BrowserSnapshotRef } from '../../shared/runtime-types'

export type CdpCommandSender = (
  method: string,
  params?: Record<string, unknown>
) => Promise<unknown>

type AXNode = {
  nodeId: string
  backendDOMNodeId?: number
  role?: { type: string; value: string }
  name?: { type: string; value: string }
  properties?: { name: string; value: { type: string; value: unknown } }[]
  childIds?: string[]
  ignored?: boolean
}

type SnapshotEntry = {
  ref: string
  role: string
  name: string
  backendDOMNodeId: number
  depth: number
}

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

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem'
])

const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'region',
  'form',
  'search'
])

const HEADING_PATTERN = /^heading$/

const SKIP_ROLES = new Set(['none', 'presentation', 'generic'])

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

function walkTree(
  node: AXNode,
  nodeById: Map<string, AXNode>,
  depth: number,
  entries: SnapshotEntry[],
  nextRef: () => number
): void {
  if (node.ignored) {
    walkChildren(node, nodeById, depth, entries, nextRef)
    return
  }

  const role = node.role?.value ?? ''
  const name = node.name?.value ?? ''

  if (SKIP_ROLES.has(role)) {
    walkChildren(node, nodeById, depth, entries, nextRef)
    return
  }

  const isInteractive = INTERACTIVE_ROLES.has(role)
  const isHeading = HEADING_PATTERN.test(role)
  const isLandmark = LANDMARK_ROLES.has(role)
  const isStaticText = role === 'staticText' || role === 'StaticText'

  if (!isInteractive && !isHeading && !isLandmark && !isStaticText) {
    walkChildren(node, nodeById, depth, entries, nextRef)
    return
  }

  if (!name && !isLandmark) {
    walkChildren(node, nodeById, depth, entries, nextRef)
    return
  }

  const hasFocusable = isInteractive && isFocusable(node)

  if (isLandmark) {
    entries.push({
      ref: '',
      role: formatLandmarkRole(role, name),
      name: name || role,
      backendDOMNodeId: node.backendDOMNodeId ?? 0,
      depth
    })
    walkChildren(node, nodeById, depth + 1, entries, nextRef)
    return
  }

  if (isHeading) {
    entries.push({
      ref: '',
      role: 'heading',
      name,
      backendDOMNodeId: node.backendDOMNodeId ?? 0,
      depth
    })
    return
  }

  if (isStaticText && name.trim().length > 0) {
    entries.push({
      ref: '',
      role: 'text',
      name: name.trim(),
      backendDOMNodeId: node.backendDOMNodeId ?? 0,
      depth
    })
    return
  }

  if (isInteractive && (hasFocusable || node.backendDOMNodeId)) {
    const ref = `@e${nextRef()}`
    entries.push({
      ref,
      role: formatInteractiveRole(role),
      name: name || '(unlabeled)',
      backendDOMNodeId: node.backendDOMNodeId ?? 0,
      depth
    })
    return
  }

  walkChildren(node, nodeById, depth, entries, nextRef)
}

function walkChildren(
  node: AXNode,
  nodeById: Map<string, AXNode>,
  depth: number,
  entries: SnapshotEntry[],
  nextRef: () => number
): void {
  if (!node.childIds) {
    return
  }
  for (const childId of node.childIds) {
    const child = nodeById.get(childId)
    if (child) {
      walkTree(child, nodeById, depth, entries, nextRef)
    }
  }
}

function isFocusable(node: AXNode): boolean {
  if (!node.properties) {
    return true
  }
  const focusable = node.properties.find((p) => p.name === 'focusable')
  if (focusable && focusable.value.value === false) {
    return false
  }
  return true
}

function formatInteractiveRole(role: string): string {
  switch (role) {
    case 'textbox':
    case 'searchbox':
      return 'text input'
    case 'combobox':
      return 'combobox'
    case 'menuitem':
    case 'menuitemcheckbox':
    case 'menuitemradio':
      return 'menu item'
    case 'spinbutton':
      return 'number input'
    case 'treeitem':
      return 'tree item'
    default:
      return role
  }
}

function formatLandmarkRole(role: string, name: string): string {
  if (name) {
    return `[${name}]`
  }
  switch (role) {
    case 'banner':
      return '[Header]'
    case 'navigation':
      return '[Navigation]'
    case 'main':
      return '[Main Content]'
    case 'complementary':
      return '[Sidebar]'
    case 'contentinfo':
      return '[Footer]'
    case 'search':
      return '[Search]'
    default:
      return `[${role}]`
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

// Why: finds DOM elements that are visually interactive (cursor:pointer, onclick,
// tabindex, contenteditable) but lack standard ARIA roles. These are common in
// modern SPAs where styled <div>s act as buttons. Returns them as a JS array of
// remote object references that we can resolve to backendNodeIds via CDP.
async function findCursorInteractiveElements(
  sendCommand: CdpCommandSender,
  existingEntries: SnapshotEntry[]
): Promise<SnapshotEntry[]> {
  const existingNodeIds = new Set(existingEntries.map((e) => e.backendDOMNodeId))
  const results: SnapshotEntry[] = []

  try {
    // Single evaluate call that finds interactive elements and returns their info
    // along with a way to reference them by index
    const { result } = (await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const SKIP_ROLES = new Set(['button','link','textbox','checkbox','radio','tab',
          'menuitem','option','switch','slider','combobox','searchbox','spinbutton','treeitem',
          'menuitemcheckbox','menuitemradio']);
        const SKIP_TAGS = new Set(['input','button','select','textarea','a']);
        const seen = new Set();
        const found = [];
        const matchedElements = [];

        function check(el) {
          if (seen.has(el)) return;
          seen.add(el);
          const tag = el.tagName.toLowerCase();
          if (SKIP_TAGS.has(tag)) return;
          const role = el.getAttribute('role');
          if (role && SKIP_ROLES.has(role)) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const text = (el.ariaLabel || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80);
          if (!text) return;
          found.push({ text, tag });
          matchedElements.push(el);
          if (found.length >= 50) return;
        }

        document.querySelectorAll('[onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]').forEach(el => {
          if (found.length < 50) check(el);
        });
        document.querySelectorAll('div, span, li, td, img, svg, label').forEach(el => {
          if (found.length >= 50) return;
          try {
            if (window.getComputedStyle(el).cursor === 'pointer') check(el);
          } catch {}
        });

        window.__orcaCursorInteractive = matchedElements;
        return JSON.stringify(found);
      })()`,
      returnByValue: true
    })) as { result: { value: string } }

    const elements = JSON.parse(result.value) as { text: string; tag: string }[]

    for (let i = 0; i < elements.length; i++) {
      try {
        const { result: objResult } = (await sendCommand('Runtime.evaluate', {
          expression: `window.__orcaCursorInteractive[${i}]`
        })) as { result: { objectId?: string } }

        if (!objResult.objectId) {
          continue
        }

        const { node } = (await sendCommand('DOM.describeNode', {
          objectId: objResult.objectId
        })) as { node: { backendNodeId: number } }

        if (existingNodeIds.has(node.backendNodeId)) {
          continue
        }

        results.push({
          ref: '',
          role: 'clickable',
          name: elements[i].text,
          backendDOMNodeId: node.backendNodeId,
          depth: 0
        })
      } catch {
        continue
      }
    }

    // Clean up
    await sendCommand('Runtime.evaluate', {
      expression: 'delete window.__orcaCursorInteractive',
      returnByValue: true
    })
  } catch {
    // DOM query failed — not critical, just return empty
  }

  return results
}
