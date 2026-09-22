export type AXNode = {
  nodeId: string
  backendDOMNodeId?: number
  role?: { type: string; value: string }
  name?: { type: string; value: string }
  properties?: { name: string; value: { type: string; value: unknown } }[]
  childIds?: string[]
  ignored?: boolean
}

export type SnapshotEntry = {
  ref: string
  role: string
  name: string
  backendDOMNodeId: number
  depth: number
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

export function walkTree(
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
