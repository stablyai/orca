import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'

import {
  diffCounts,
  formatCountBaseline,
  listTrackedFiles,
  parseCountBaseline,
  pruneCountBaseline,
  totalCount
} from './ratchet-baseline.mjs'

// Ratchet layout writers downward: main Store/session-partition writes and renderer layout/selection keys/spreads.
// Exclude existing-entry content updates; shorthand counts only in store writes, and deleted symbols stay compiler-owned.

// Partition fields of the saved workspace session (census class 1).
const SESSION_PARTITION_FIELDS = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'activeTabIdByWorktree',
  'activeWorktreeId',
  'openFilesByWorktree',
  'browserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'tabBarOrderByWorktree',
  'sleepingAgentSessionsByPaneKey',
  'terminalPtyIncarnationsByPaneKey',
  'defaultTerminalTabsAppliedByWorktreeId',
  'lastVisitedAtByWorktreeId',
  'browserUrlHistory'
]
const SESSION_FIELDS = ['workspaceSession', 'workspaceSessionsByHostId']
// Tab and pane-layout fields edited in place inside a partition (census class 1, third search).
const SESSION_TAB_FIELDS = [
  'ptyId',
  'ptyIdsByLeafId',
  'customTitle',
  'titlesByLeafId',
  'buffersByLeafId',
  'activeLeafId'
]

// Window layout fields of acceptance 1 and the per-view selection fields (census class 2).
const RENDERER_LAYOUT_FIELDS = new Set([
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'tabBarOrderByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'openFiles',
  'browserTabsByWorktree',
  'activeGroupIdByWorktree',
  'activeTabIdByWorktree',
  'activeTabId',
  'activeFileIdByWorktree',
  'activeFileId',
  'activeBrowserTabIdByWorktree',
  'activeBrowserTabId',
  'activeTabTypeByWorktree',
  'activeTabType',
  'ptyIdsByTabId'
])

export const RATCHETS = [
  {
    id: 'main',
    label: 'main-process layout writer(s)',
    scanRoot: 'src/main',
    baselinePath: 'config/main-layout-writer-baseline.txt',
    // Count Store layout setter calls and method values, including internal partition writers.
    writerNames: new Set([
      'setWorkspaceSession',
      'patchWorkspaceSession',
      'stageWorkspaceSessionBeforeUnload',
      'setWorkspaceSessionForWorktree',
      'setForWorktree',
      'persistPtyBinding',
      'retirePtyBinding',
      'moveTerminalLeafToNewTab',
      'admitTerminalPane',
      'withdrawTerminalPane',
      'removeWorkspaceSessionHost',
      'removeWorkspaceSessionStateForWorktree',
      'setHostWorkspaceSession',
      'setLocalWorkspaceSession',
      'applyPtyBinding',
      'removeWorkspaceSessionOwner',
      'removeWorkspaceSessionOwners',
      'removeWorkspaceSessionOwnerEverywhere',
      'removeWorkspaceSessionOwnersEverywhere',
      'removeWorkspaceSessionOwnerInPartition',
      'deleteScannedSessionFieldsForOwners',
      'removeRepoFromWorkspaceSession',
      'removeRepoFromHostWorkspaceSessions',
      'applyPreparedOrcadMigrationWorkspaceSession',
      'applyPayloadToTarget',
      'removeSourceRepo',
      'clearSshRemotePtyBindingsForTarget',
      'clearSshRemotePtyBindingsForLeases'
    ]),
    assignedFields: new Set([
      ...SESSION_FIELDS,
      ...SESSION_PARTITION_FIELDS,
      ...SESSION_TAB_FIELDS,
      'mobileClientTabSelectionsByDeviceId'
    ]),
    // These names also key unrelated main objects, so only the session itself counts as a key.
    keyedFields: new Set(SESSION_FIELDS),
    entryContentFields: new Set(),
    allowed: () => false,
    header: [
      '# Main-process writers of saved workspace layout, per file: calls of the Store layout',
      '# setters, plus assignments, deletes and object keys that edit session partitions directly.',
      '# This is a RATCHET: counts may only go DOWN. Layout moves to one runtime owner; do not add',
      '# writers. Prune after removing writers: pnpm check:layout-writer-ratchets --prune'
    ]
  },
  {
    id: 'renderer',
    label: 'renderer layout write(s)',
    scanRoot: 'src/renderer/src',
    baselinePath: 'config/renderer-layout-writer-baseline.txt',
    writerNames: new Set(),
    assignedFields: RENDERER_LAYOUT_FIELDS,
    keyedFields: RENDERER_LAYOUT_FIELDS,
    // Mapping existing entries preserves membership/order; treat draft/status/URL edits as content only.
    entryContentFields: new Set(['openFiles', 'browserTabsByWorktree']),
    // The three writers the plan allows: applyFromRuntime, the frozen mirror's store patch and
    // the frozen setters for remote-server workspaces.
    allowed: (rel) =>
      rel === 'src/renderer/src/store/workspace-layout-cache.ts' ||
      rel === 'src/renderer/src/runtime/web-session-tabs-sync/store-patch.ts' ||
      rel.startsWith('src/renderer/src/runtime/remote-workspace-frozen/'),
    header: [
      '# Renderer writes of the window layout and per-view selection fields, per file: assignments,',
      '# deletes, object keys and string keys (computed-key writes). Same-name copies are reads.',
      '# This is a RATCHET: counts may only GO DOWN. Layout comes from the runtime; send a command',
      '# instead. Prune after removing writes: pnpm check:layout-writer-ratchets --prune'
    ]
  }
]

// Census test filter: test, fixture and harness files are not product writers.
export function isScannedPath(rel) {
  return (
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.|\/tests?\/|__tests__|test-support|fixture|harness|e2e\//.test(rel)
  )
}

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken
])

/** A string-literal key; a variable key (`exitCodes[ptyId]`) names no field. */
function literalKey(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
}

function staticName(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    return node.text
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isComputedPropertyName(node)) {
    return literalKey(node.expression)
  }
  return null
}

/** The field a write target (`a.b[c]!.d`) goes through, if any; root identifiers are locals. */
function targetedField(node, fields) {
  let current = node
  while (current) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression
    } else if (ts.isPropertyAccessExpression(current)) {
      if (fields.has(current.name.text)) {
        return current.name.text
      }
      current = current.expression
    } else if (ts.isElementAccessExpression(current)) {
      const key = literalKey(current.argumentExpression)
      if (key !== null && fields.has(key)) {
        return key
      }
      current = current.expression
    } else {
      return null
    }
  }
  return null
}

function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** An existing value read as-is: `s.openFiles`, `s.tabs[id] ?? []`. */
function isPlainRead(node) {
  const current = unwrap(node)
  if (ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword) {
    return true
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return isPlainRead(current.expression)
  }
  if (
    ts.isBinaryExpression(current) &&
    (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const right = unwrap(current.right)
    const emptyLiteral =
      (ts.isArrayLiteralExpression(right) && right.elements.length === 0) ||
      (ts.isObjectLiteralExpression(right) && right.properties.length === 0)
    return isPlainRead(current.left) && (emptyLiteral || isPlainRead(right))
  }
  return false
}

/** `list.map(…)`, or `{ ...map, [key]: list.map(…) }`: same entries in the same order. */
function keepsMembership(node) {
  const value = unwrap(node)
  if (ts.isCallExpression(value)) {
    const callee = unwrap(value.expression)
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'map' &&
      isPlainRead(callee.expression)
    )
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.every(
      (property) =>
        (ts.isSpreadAssignment(property) && isPlainRead(property.expression)) ||
        (ts.isPropertyAssignment(property) && keepsMembership(property.initializer))
    )
  }
  return false
}

const STORE_SET_CALLS = new Set(['set', 'setState'])

/** Whether an object literal is a store write: `set({ … })`, `set((s) => ({ … }))` or a writer call. */
function isPassedToWriter(objectLiteral, writerNames) {
  let node = objectLiteral
  for (;;) {
    const parent = node.parent
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isConditionalExpression(parent)
    ) {
      node = parent
    } else if (ts.isArrowFunction(parent) && parent.body === node) {
      node = parent
    } else if (ts.isReturnStatement(parent)) {
      let fn = parent.parent
      while (fn && !ts.isFunctionLike(fn)) {
        fn = fn.parent
      }
      if (!fn) {
        return false
      }
      node = fn
    } else {
      break
    }
  }
  const call = node.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(node)) {
    return false
  }
  const callee = unwrap(call.expression)
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null
  return name !== null && (STORE_SET_CALLS.has(name) || writerNames.has(name))
}

/** `{ tabsByWorktree: s.tabsByWorktree }` copies a value under its own name: a selector read. */
function isSameNameCopy(property, name) {
  let value = property.initializer
  while (ts.isParenthesizedExpression(value) || ts.isNonNullExpression(value)) {
    value = value.expression
  }
  return ts.isPropertyAccessExpression(value) && value.name.text === name
}

/** Layout writes in one file under one ratchet's rules. */
export function countLayoutWrites(sourceText, ratchet, fileName = 'file.tsx') {
  const names = [...ratchet.writerNames, ...ratchet.assignedFields]
  if (!names.some((name) => sourceText.includes(name))) {
    return 0
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  let count = 0
  const visit = (node) => {
    if (
      (ts.isPropertyAccessExpression(node) && ratchet.writerNames.has(node.name.text)) ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ratchet.writerNames.has(node.expression.text))
    ) {
      count += 1
    } else if (
      ts.isBinaryExpression(node) &&
      ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
      targetedField(node.left, ratchet.assignedFields) !== null
    ) {
      const field = targetedField(node.left, ratchet.assignedFields)
      if (!(ratchet.entryContentFields.has(field) && keepsMembership(node.right))) {
        count += 1
      }
    } else if (
      ts.isDeleteExpression(node) &&
      targetedField(node.expression, ratchet.assignedFields) !== null
    ) {
      count += 1
    } else if (
      ts.isShorthandPropertyAssignment(node) &&
      ratchet.keyedFields.has(node.name.text) &&
      // A shorthand elsewhere passes a value on (`return { activeTabId, tabsByWorktree }`).
      isPassedToWriter(node.parent, ratchet.writerNames)
    ) {
      count += 1
    } else if (ts.isPropertyAssignment(node)) {
      const name = staticName(node.name)
      if (
        name !== null &&
        ratchet.keyedFields.has(name) &&
        !isSameNameCopy(node, name) &&
        !(ratchet.entryContentFields.has(name) && keepsMembership(node.initializer))
      ) {
        count += 1
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      ratchet.keyedFields.has(node.text) &&
      // Object keys and element reads are judged above; `'tabsByWorktree'` elsewhere feeds a
      // computed-key write (`patch[key] = …`), which cannot be resolved statically.
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !ts.isComputedPropertyName(node.parent) &&
      !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) &&
      !(
        ts.isCallExpression(node.parent) &&
        !node.parent.questionDotToken &&
        node.parent.arguments.length === 2 &&
        node.parent.arguments[1] === node &&
        ts.isPropertyAccessExpression(node.parent.expression) &&
        !node.parent.expression.questionDotToken &&
        ts.isIdentifier(node.parent.expression.expression) &&
        node.parent.expression.expression.text === 'Object' &&
        node.parent.expression.name.text === 'hasOwn'
      ) &&
      !ts.isLiteralTypeNode(node.parent)
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return count
}

export function collectCurrentCounts(ratchet, root = process.cwd()) {
  const counts = new Map()
  for (const rel of listTrackedFiles(root, [ratchet.scanRoot]).filter(isScannedPath)) {
    if (ratchet.allowed(rel)) {
      continue
    }
    let text
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      // Deleted in the working tree but still tracked.
      continue
    }
    const found = countLayoutWrites(text, ratchet, rel)
    if (found > 0) {
      counts.set(rel, found)
    }
  }
  return counts
}

const ADVICE =
  'Workspace layout is moving to one runtime owner; send a layout command instead of writing it here.'

export function main(root = process.cwd()) {
  let failed = false
  for (const ratchet of RATCHETS) {
    const baselineFile = path.join(root, ratchet.baselinePath)
    if (!fs.existsSync(baselineFile)) {
      console.error(`::error::Missing ${ratchet.baselinePath}.`)
      failed = true
      continue
    }
    const current = collectCurrentCounts(ratchet, root)
    const { grown, shrunk } = diffCounts(
      current,
      parseCountBaseline(fs.readFileSync(baselineFile, 'utf8'))
    )
    for (const { file, now, allowed } of grown) {
      console.error(
        `::error file=${file}::${now} ${ratchet.label}, baseline allows ${allowed}. ${ADVICE}`
      )
    }
    // Why: a removal must not fail PRs that branched before it; only growth fails.
    for (const { file, now, allowed } of shrunk) {
      console.warn(
        `::warning file=${file}::${now} ${ratchet.label}, baseline still allows ${allowed}. Run: pnpm check:layout-writer-ratchets --prune`
      )
    }
    if (grown.length > 0) {
      failed = true
    } else {
      console.log(
        `Layout-writer ratchet (${ratchet.id}) OK — ${totalCount(current)} ${ratchet.label}.`
      )
    }
  }
  return failed ? 1 : 0
}

export function prune(root = process.cwd()) {
  for (const ratchet of RATCHETS) {
    const current = collectCurrentCounts(ratchet, root)
    const kept = pruneCountBaseline(root, ratchet.baselinePath, ratchet.header, current)
    console.log(`Pruned ${ratchet.baselinePath} to ${kept} ${ratchet.label}.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  if (process.argv[2] === '--init') {
    // One-time bootstrap of the baselines from today's tree.
    for (const ratchet of RATCHETS) {
      const counts = collectCurrentCounts(ratchet, root)
      fs.writeFileSync(
        path.join(root, ratchet.baselinePath),
        formatCountBaseline(counts, ratchet.header)
      )
    }
  } else if (process.argv[2] === '--prune') {
    prune(root)
  }
  process.exit(main(root))
}
