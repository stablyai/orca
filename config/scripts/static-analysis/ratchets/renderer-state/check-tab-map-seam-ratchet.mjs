import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'

// The tab-map transition seam (store/keyed-record-transitions.ts) only works if its writers annotate and its
// consumers enumerate whole maps only on named cold paths; this pins both for the repaired modules, nothing wider.

const R = 'src/renderer/src/'
const STATUS = `${R}components/native-chat/session/status/`

/** Repaired consumers: the only functions allowed to walk a whole map, and which callers may reach a whole-list helper. */
export const CONSUMERS = new Map([
  [
    `${STATUS}structured-agent-session-tabs.ts`,
    { coldPaths: new Set(['rebuildFromSnapshot']), helpers: { rebuildFromSnapshot: ['project'] } }
  ],
  [
    `${STATUS}StructuredAgentSessionStatusBridge.tsx`,
    {
      coldPaths: new Set(['reconcileFromSnapshot']),
      helpers: { getStructuredAgentSessionTabs: ['reconcileFromSnapshot'] }
    }
  ],
  [
    `${STATUS}structured-agent-session-status-membership.ts`,
    { coldPaths: new Set(), helpers: { getStructuredAgentSessionTabs: [] } }
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
  'src/renderer/src/store/terminals/terminal-tab-close.ts',
  'src/renderer/src/store/terminals/terminal-tab-creation.ts',
  'src/renderer/src/store/terminals/terminal-tab-navigation.ts',
  'src/renderer/src/store/terminals/terminal-tab-title-batch.ts',
  'src/renderer/src/store/terminals/workspace-terminal-hydration-patch.ts',
  'src/renderer/src/store/terminals/workspace-terminal-hydration.ts',
  'src/renderer/src/store/terminals/workspace-terminal-reconnect.ts',
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

function calleeName(call) {
  const callee = call.expression
  if (ts.isIdentifier(callee)) {
    return { object: null, name: callee.text }
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return {
      object: ts.isIdentifier(callee.expression) ? callee.expression.text : null,
      name: callee.name.text
    }
  }
  return { object: null, name: null }
}

export function consumerViolations(file, text, { coldPaths, helpers }) {
  const source = parse(file, text)
  const violations = []
  const visit = (node) => {
    let what = null
    let allowed = coldPaths
    if (ts.isCallExpression(node)) {
      const { object, name } = calleeName(node)
      if (object === 'Object' && ENUMERATING_CALLS.has(name)) {
        what = `Object.${name}`
      } else if (object === null && Object.hasOwn(helpers, name)) {
        what = `${name}()`
        allowed = new Set(helpers[name])
      }
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

export function writerViolations(file, text) {
  const source = parse(file, text)
  const violations = []
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      SEAM_FIELDS.has(node.name.text) &&
      isRawRecord(node.initializer)
    ) {
      violations.push(
        `${file}:${line(source, node)} raw ${node.name.text} record; build it with replaceTabBuckets/replaceRecordEntries or annotate it`
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
