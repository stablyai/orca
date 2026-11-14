import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'

// The tab-map transition seam (store/keyed-record-transitions.ts) only works if its writers annotate and its
// consumers enumerate whole maps only on named cold paths; this pins both for the repaired modules, nothing wider.

const R = 'src/renderer/src/'
const STATUS = `${R}components/native-chat/session/status/`

/**
 * Repaired consumers: the only functions allowed to walk a whole map (`coldPaths`), which callers
 * may reach a cold helper (`helpers`), and the only values they may import, so a new walking helper
 * can't arrive through an import unreviewed.
 */
export const CONSUMERS = new Map([
  [
    `${STATUS}structured-agent-session-tabs.ts`,
    {
      coldPaths: new Set(['rebuildFromSnapshot']),
      helpers: { rebuildFromSnapshot: ['advance'] },
      imports: new Set(['structuredAgentSessionPaneKey', 'isStructuredTab', 'readTabMapChanges'])
    }
  ],
  [
    `${STATUS}StructuredAgentSessionStatusBridge.tsx`,
    {
      coldPaths: new Set(['reconcileFromSnapshot']),
      helpers: {
        getStructuredAgentSessionTabs: ['reconcileFromSnapshot'],
        reconcileFromSnapshot: ['reconcile']
      },
      imports: new Set([
        'useEffect',
        'projectStatus',
        'getStructuredAgentSessionLaunchLifecycle',
        'subscribeStructuredAgentLaunchStatus',
        'getStructuredAgentSessionLaunchFailedAt',
        'useAppStore',
        'structuredAgentSessionTargetForHost',
        'getStructuredAgentSessionStatusFeed',
        'structuredAgentSessionStatusFeedKey',
        'getStructuredAgentSessionTabs',
        'getStructuredAgentSessionTabsInWorkspace',
        'readTabMapChanges',
        'createTabOwnerCache',
        'ownerInputChanged',
        'ownerInputs',
        'createStructuredSessionMembership',
        'sameSemanticTab'
      ])
    }
  ],
  [
    `${STATUS}structured-agent-session-status-membership.ts`,
    {
      coldPaths: new Set(),
      helpers: { getStructuredAgentSessionTabs: [] },
      imports: new Set(['structuredAgentSessionPaneKey'])
    }
  ]
])
const ENUMERATING_CALLS = new Set(['keys', 'values', 'entries'])

/** Shared tab-map writers wired to the seam: a raw record literal for these fields bypasses provenance. */
export const WRITERS = [
  'src/renderer/src/runtime/web-session-tabs-sync/scoped-patch-annotation.ts',
  'src/renderer/src/runtime/web-session-tabs-sync/store-patch.ts',
  'src/renderer/src/runtime/workspace-layout/frames/workspace-layout-frame-sync.ts',
  'src/renderer/src/store/slices/browser/pages/browser-page-state-actions.ts',
  'src/renderer/src/store/slices/editor/file-ids/hydrated-editor-file-ids.ts',
  'src/renderer/src/store/slices/editor/hydration/restored-editor-owner-in-place.ts',
  'src/renderer/src/store/slices/editor/hydration/restored-editor-owner-transition.ts',
  'src/renderer/src/store/slices/editor/markdown/markdown-preview-actions.ts',
  'src/renderer/src/store/slices/editor/opening/open-file-mutations.ts',
  'src/renderer/src/store/slices/ssh/ssh-target-cleanup.ts',
  'src/renderer/src/store/slices/tabs/rename-worktree-layout.ts',
  'src/renderer/src/store/slices/tabs/tab-group-state.ts',
  'src/renderer/src/store/slices/tabs/tabs-close-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-create-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-drag-preview-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-drop-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-focus-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-group-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-host-mirroring.ts',
  'src/renderer/src/store/slices/tabs/tabs-label-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-move-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-reconciliation.ts',
  'src/renderer/src/store/slices/tabs/tabs-session-actions.ts',
  'src/renderer/src/store/slices/tabs/tabs-split-ratio-actions.ts',
  'src/renderer/src/store/slices/tabs/worktree-layout-lifecycle.ts',
  'src/renderer/src/store/slices/tabs/worktree-terminal-tab-respawn.ts',
  'src/renderer/src/store/slices/worktrees/session/set-active-worktree.ts',
  'src/renderer/src/store/slices/worktrees/session/worktree-identity-rename-state.ts',
  'src/renderer/src/store/slices/worktrees/session/worktree-slice-lookups.ts',
  'src/renderer/src/store/slices/worktrees/teardown/record-key-omission.ts',
  'src/renderer/src/store/terminals/retirement/terminal-tab-close.ts',
  'src/renderer/src/store/terminals/tabs/creation/terminal-tab-creation.ts',
  'src/renderer/src/store/terminals/tabs/terminal-tab-navigation.ts',
  'src/renderer/src/store/terminals/tabs/presentation/terminal-tab-title-batch.ts',
  'src/renderer/src/store/terminals/hydration/workspace-terminal-hydration-patch.ts',
  'src/renderer/src/store/terminals/hydration/workspace-terminal-hydration.ts',
  'src/renderer/src/store/terminals/hydration/workspace-terminal-reconnect.ts',
  'src/renderer/src/store/workspace-layout/frames/workspace-layout-frame-store-patch.ts'
]
export const SEAM_FIELDS = new Set([
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'terminalLayoutsByTabId',
  'ptyIdsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'runtimePaneTitlesByTabId',
  'pendingStartupByTabId',
  'pendingReconnectPtyIdByTabId',
  'sleepingAgentSessionsByPaneKey',
  'layoutByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree'
])

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function line(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function enclosingFunctionNames(node) {
  const names = []
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      names.push(current.name.text)
    } else if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      names.push(current.parent.name.text)
    }
  }
  return names
}

function valueImports(source) {
  const imported = []
  for (const statement of source.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : null
    if (!clause || clause.isTypeOnly) {
      continue
    }
    if (clause.name) {
      imported.push(clause.name)
    }
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      imported.push(bindings.name)
    } else if (bindings) {
      imported.push(
        ...bindings.elements.filter((element) => !element.isTypeOnly).map((e) => e.name)
      )
    }
  }
  return imported
}

function isHelperReference(node, helpers) {
  if (!ts.isIdentifier(node) || !Object.hasOwn(helpers, node.text)) {
    return false
  }
  const parent = node.parent
  const declares =
    ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent)
  return !declares
}

export function consumerViolations(file, text, { coldPaths, helpers, imports }) {
  const source = parse(file, text)
  const violations = []
  for (const name of valueImports(source)) {
    if (!imports.has(name.text)) {
      violations.push(
        `${file}:${line(source, name)} imports ${name.text}; repaired consumers import only reviewed helpers`
      )
    }
  }
  const visit = (node) => {
    let what = null
    let allowed = coldPaths
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Object' &&
      ENUMERATING_CALLS.has(node.name.text)
    ) {
      // Any reference, called or aliased (`const keys = Object.keys`).
      what = `Object.${node.name.text}`
    } else if (isHelperReference(node, helpers)) {
      // Calls, aliases (`const resync = reconcileFromSnapshot`) and callbacks alike.
      what = `${node.text}()`
      allowed = new Set(helpers[node.text])
    } else if (ts.isForInStatement(node)) {
      what = 'for…in'
    }
    if (what && !enclosingFunctionNames(node).some((name) => allowed.has(name))) {
      violations.push(`${file}:${line(source, node)} ${what} outside a named cold path`)
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'rebuildFromSnapshot' &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      violations.push(`${file}:${line(source, node)} rebuildFromSnapshot must stay module-private`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function isRawRecord(expression) {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => ts.isSpreadAssignment(property))
  }
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'Object' &&
    ['fromEntries', 'assign'].includes(expression.expression.name.text)
  )
}

// Only an explicit cold-path mark certifies a record built outside a construction helper or draft.
const ANNOTATED_ARGUMENT = {
  markFullResync: 0
}

function enclosingScope(node) {
  let current = node.parent
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
    current = current.parent
  }
  return current
}

/** The value a local name holds at `use`: its declaration's initializer, followed through aliases. */
function bindingSource(name, scope, use, seen = new Set()) {
  if (seen.has(name)) {
    return null
  }
  seen.add(name)
  let found = null
  const visit = (node) => {
    if (node.pos >= use.pos) {
      return
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.initializer ?? null
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      found = node.right
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  if (found && ts.isIdentifier(found)) {
    const aliased = bindingSource(found.text, scope, use, seen)
    return aliased && { ...aliased, names: [name, ...aliased.names] }
  }
  return found && { value: found, names: [name] }
}

/** Whether a seam helper annotates one of `names` in place before `use` publishes it. */
function annotatedBefore(names, scope, use) {
  let annotated = false
  const visit = (node) => {
    if (node.pos >= use.pos) {
      return
    }
    if (
      node.end <= use.pos &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      Object.hasOwn(ANNOTATED_ARGUMENT, node.expression.text)
    ) {
      const argument = node.arguments[ANNOTATED_ARGUMENT[node.expression.text]]
      annotated ||=
        argument !== undefined && ts.isIdentifier(argument) && names.includes(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return annotated
}

function rawValue(node) {
  const initializer = ts.isShorthandPropertyAssignment(node) ? node.name : node.initializer
  if (isRawRecord(initializer)) {
    return true
  }
  if (!ts.isIdentifier(initializer)) {
    return false
  }
  // Follow the local binding and its aliases; the record must be annotated before it is published.
  for (let scope = enclosingScope(node); scope; scope = scope.parent && enclosingScope(scope)) {
    const binding = bindingSource(initializer.text, scope, node)
    if (binding) {
      return isRawRecord(binding.value) && !annotatedBefore(binding.names, scope, node)
    }
    if (ts.isSourceFile(scope)) {
      break
    }
  }
  return false
}

export function writerViolations(file, text) {
  const source = parse(file, text)
  const violations = []
  const visit = (node) => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      SEAM_FIELDS.has(node.name.text) &&
      rawValue(node)
    ) {
      violations.push(
        `${file}:${line(source, node)} raw ${node.name.text} record; build it with a replace helper or draft, or mark it full resync`
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

export function collect(root = process.cwd()) {
  const violations = []
  for (const [file, rules] of CONSUMERS) {
    violations.push(
      ...consumerViolations(file, fs.readFileSync(path.join(root, file), 'utf8'), rules)
    )
  }
  for (const file of WRITERS) {
    violations.push(...writerViolations(file, fs.readFileSync(path.join(root, file), 'utf8')))
  }
  return violations
}

export function main(root = process.cwd()) {
  const violations = collect(root)
  if (violations.length) {
    for (const violation of violations) {
      console.error(violation)
    }
    console.error(
      'Tab-map seam: ordinary handlers use addressed deltas (readTabMapChanges); whole-map walks belong only in the named cold paths.'
    )
    return 1
  }
  console.log(
    `tab-map-seam ratchet OK — ${CONSUMERS.size} consumer and ${WRITERS.length} writer modules pinned.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd()))
}
