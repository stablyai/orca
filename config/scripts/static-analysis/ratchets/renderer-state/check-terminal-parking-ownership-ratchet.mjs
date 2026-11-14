import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'

const RENDERER = 'src/renderer/src/'
const WATCHERS = `${RENDERER}components/terminal-pane/parking/output-watchers/`
const ROOTS = new Map([
  [
    `${RENDERER}components/terminal/terminal-provider-snapshot-bound-pty-ids.ts`,
    ['createTerminalProviderSnapshotBoundPtyIdsSelector']
  ],
  [`${RENDERER}components/use-terminal-watcher-effects.ts`, ['useTerminalWatcherEffects']],
  [`${RENDERER}components/use-terminal-parking-pass.ts`, ['useTerminalParkingPass']],
  [
    `${RENDERER}components/terminal-parking-pass-candidates.ts`,
    ['collectTerminalParkingPassCandidates']
  ],
  [`${RENDERER}components/terminal/split-group-mount.ts`, ['anyMountedWorktreeHasLayout']],
  [
    `${RENDERER}components/terminal-pane/parking/lifecycle/use-parked-terminal-watcher-synchronization.ts`,
    ['useParkedTerminalWatcherSynchronization']
  ],
  [
    `${RENDERER}components/terminal-pane/parking/lifecycle/use-terminal-tab-cold-parking.ts`,
    ['useTerminalTabColdParking']
  ],
  [`${WATCHERS}terminal-parked-tab-watchers.ts`, ['syncParkedTerminalTabWatchers']],
  [`${WATCHERS}parked-terminal-tab-coverage.ts`, ['canWatcherCoverParkedTerminalTab']],
  [
    `${RENDERER}lib/agent-session/resume/resume-sleeping-agent-session.ts`,
    ['resumeSleepingAgentSessionsForWorktree']
  ]
])
const HOT_MAPS = new Set([
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'terminalLayoutsByTabId',
  'sleepingAgentSessionsByPaneKey'
])
const OWNER_ROOTS = [
  {
    rel: 'store/terminals/parking/terminal-parking-input-owner.ts',
    name: 'acceptTerminalParkingInputs',
    inputs: []
  },
  {
    rel: 'store/terminals/parking/terminal-parking-input-owner.ts',
    name: 'publishAcceptedTerminalParkingInputs',
    inputs: []
  },
  {
    rel: 'store/terminals/parking/terminal-parking-input-owner.ts',
    name: 'invalidateTerminalParkingPtyInputs',
    inputs: []
  },
  {
    rel: 'store/terminals/ownership/terminal-tab-owner-index.ts',
    name: 'update',
    inputs: ['tabsByWorktree']
  },
  {
    rel: 'store/terminals/sleep/sleeping-agent-record-index.ts',
    name: 'update',
    inputs: ['records']
  },
  {
    rel: 'store/terminals/sleep/sleeping-agent-record-index.ts',
    name: 'acceptTransition',
    inputs: ['previous', 'next']
  },
  {
    rel: 'lib/workspace/tabs/worktree-tab-bucket-projection.ts',
    name: 'project',
    inputs: ['source']
  }
]
const KEY_DIFFS = new Set([
  `${RENDERER}store/terminals/parking/terminal-parking-input-owner.ts#diffUnknownParkingRecordKeys`,
  `${RENDERER}store/terminals/ownership/terminal-tab-owner-index.ts#diffUnknownTabOwnerKeys`,
  `${RENDERER}store/terminals/sleep/sleeping-agent-record-index.ts#diffUnknownSleepingRecordKeys`,
  `${RENDERER}lib/workspace/tabs/worktree-tab-bucket-projection.ts#diffUnknownProjectionKeys`
])
const COLD_RESYNCS = new Set([
  `${RENDERER}store/terminals/parking/terminal-parking-input-owner.ts#resyncTerminalParkingWorkspaceIds`,
  `${RENDERER}store/terminals/sleep/sleeping-agent-record-index.ts#resyncSleepingAgentRecordKeys`
])

function isColdResyncCall(node, source) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (
      ts.isConditionalExpression(ancestor) &&
      ancestor.condition.getText(source) === 'previous' &&
      node.pos >= ancestor.whenFalse.pos
    ) {
      return true
    }
    if (
      ts.isBinaryExpression(ancestor) &&
      ancestor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ancestor.left.getText(source) === 'keys'
    ) {
      return true
    }
    if (
      ts.isIfStatement(ancestor) &&
      node.pos >= ancestor.thenStatement.pos &&
      node.end <= ancestor.thenStatement.end
    ) {
      const condition = ancestor.expression.getText(source).replace(/\s+/g, ' ')
      if (
        condition === 'ptyIds === undefined' ||
        condition.includes(
          'previous.settings?.terminalSshViewParking !== state.settings?.terminalSshViewParking'
        )
      ) {
        return true
      }
    }
  }
  return false
}
const STORE_BOUNDARIES = new Set([`${RENDERER}store/index.ts`, `${RENDERER}store.ts`])
// Resource delivery and startup recovery are separate entry points, not parking input discovery.
const EFFECT_BOUNDARIES = new Set([
  `${RENDERER}components/terminal/terminal-provider-snapshot-bound-pty-ids.ts#resyncUnknownSnapshot`,
  `${RENDERER}components/terminal/use-terminal-startup-activation.ts#useTerminalStartupActivation`,
  `${WATCHERS}terminal-parked-pty-watcher.ts#startParkedPtyWatcher`,
  `${RENDERER}components/terminal-pane/parking/capture/parked-terminal-buffer-capture.ts#captureParkedTerminalBuffers`,
  `${RENDERER}lib/agent-session/resume/sleeping-agent-session-launch.ts#launchSleepingAgentSession`,
  `${RENDERER}lib/agent-session/resume/host-mirror-handle-gap-wait.ts#parkUntilHostMirrorHandleLands`,
  `${RENDERER}runtime/web-session-tabs-sync/hydration/host-session-mirror-hydration.ts#parkUntilHostSessionMirrorHydrates`
])
const ENUMERATORS = new Set(['entries', 'values', 'keys', 'assign'])

const ADDRESSED_FIELDS = new Set([
  'terminalLayoutsByTabId',
  'ptyIdsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'runtimePaneTitlesByTabId',
  'pendingStartupByTabId',
  'sleepingAgentSessionsByPaneKey'
])
const ORDINARY_WRITERS = [
  'store/terminals/layout/terminal-layout-state.ts',
  'store/terminals/sleep/terminal-pane-hibernation.ts',
  'store/terminals/pty/terminal-pty-bindings.ts',
  'store/terminals/pty/terminal-pty-release.ts',
  'store/terminals/retirement/terminal-orphan-cleanup.ts',
  'store/terminals/tabs/creation/terminal-startup-queues.ts',
  'store/terminals/tabs/presentation/terminal-tab-presentation.ts',
  'store/terminals/sleep/terminal-shutdown-state.ts',
  'store/terminals/tabs/creation/window-tab-start-in-main.ts',
  'store/slices/agent-status/agent-status-live-reducer.ts',
  'store/slices/agent-status/agent-status-launch-actions.ts',
  'store/slices/agent-status/agent-status-provider-session-actions.ts',
  'store/slices/agent-status/agent-status-recovery-actions.ts',
  'store/slices/agent-status/agent-status-authority-actions.ts'
].map((rel) => RENDERER + rel)
const RECORD_TRANSITIONS = new Set([
  'replaceRecordEntries',
  'removePaneKeys',
  'removePaneKeysByTabPrefix'
])

function collectUnaddressedWrites(root) {
  const violations = []
  for (const rel of ORDINARY_WRITERS) {
    const { source, aliases, assignments } = readModule(root, rel)
    function addressed(value, field, seen = new Set()) {
      if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
        return RECORD_TRANSITIONS.has(value.expression.text)
      }
      if (ts.isPropertyAccessExpression(value)) {
        return value.name.text === field
      }
      if (ts.isConditionalExpression(value)) {
        return addressed(value.whenTrue, field, seen) && addressed(value.whenFalse, field, seen)
      }
      if (ts.isIdentifier(value)) {
        if (seen.has(value.text)) {
          return false
        }
        seen.add(value.text)
        const alias = aliases.get(value.text)
        return (
          alias !== undefined &&
          [alias, ...(assignments.get(value.text) ?? [])].every((replacement) =>
            addressed(replacement, field, new Set(seen))
          )
        )
      }
      return false
    }
    function visit(node) {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const field =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null
        const value = ts.isPropertyAssignment(node) ? node.initializer : node.name
        if (ADDRESSED_FIELDS.has(field) && !addressed(value, field)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          violations.push(`${rel}:${line}: ${field} write needs complete record-key provenance.`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return violations
}

function resolveImport(root, from, specifier) {
  const base = specifier.startsWith('@/')
    ? RENDERER + specifier.slice(2)
    : specifier.startsWith('.')
      ? path.posix.join(path.posix.dirname(from), specifier)
      : null
  if (!base) {
    return null
  }
  return (
    [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (candidate) =>
        fs.existsSync(path.join(root, candidate)) &&
        fs.statSync(path.join(root, candidate)).isFile()
    ) ?? null
  )
}

function readModule(root, rel) {
  const source = ts.createSourceFile(
    rel,
    fs.readFileSync(path.join(root, rel), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  const imports = new Map()
  const functions = new Map()
  const aliases = new Map()
  const assignments = new Map()
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const values = assignments.get(node.left.text) ?? []
      values.push(node.right)
      assignments.set(node.left.text, values)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveImport(root, rel, node.moduleSpecifier.text)
      const bindings = node.importClause?.namedBindings
      if (target && bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          imports.set(binding.name.text, {
            rel: target,
            name: binding.propertyName?.text ?? binding.name.text
          })
        }
      }
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      node.body
    ) {
      functions.set(node.name.text, node)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      aliases.set(node.name.text, node.initializer)
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        functions.set(node.name.text, node.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { source, imports, functions, aliases, assignments }
}

export function collectParkingOwnershipViolations(root = process.cwd()) {
  const modules = new Map()
  const pending = [...ROOTS].flatMap(([rel, names]) =>
    names.map((name) => ({ rel, name, tainted: new Set() }))
  )
  for (const { rel, name, inputs } of OWNER_ROOTS) {
    pending.push({ rel: RENDERER + rel, name, tainted: new Set(inputs) })
  }
  const visited = new Set()
  const violations = new Set()
  while (pending.length) {
    const { rel, name, tainted } = pending.pop()
    if (STORE_BOUNDARIES.has(rel) || EFFECT_BOUNDARIES.has(`${rel}#${name}`)) {
      continue
    }
    const identity = `${rel}#${name}#${[...tainted].sort().join(',')}`
    if (visited.has(identity)) {
      continue
    }
    visited.add(identity)
    let mod = modules.get(rel)
    if (!mod) {
      modules.set(rel, (mod = readModule(root, rel)))
    }
    const fn = mod.functions.get(name)
    if (!fn) {
      continue
    }
    function hotMap(node, seen = new Set()) {
      if (ts.isPropertyAccessExpression(node)) {
        if (HOT_MAPS.has(node.name.text)) {
          return true
        }
        if (ts.isIdentifier(node.expression)) {
          const value = mod.aliases.get(node.expression.text)
          if (value && ts.isObjectLiteralExpression(value)) {
            const property = value.properties.find(
              (candidate) =>
                ts.isPropertyAssignment(candidate) &&
                candidate.name.getText(mod.source) === node.name.text
            )
            if (property && ts.isPropertyAssignment(property)) {
              return hotMap(property.initializer, seen)
            }
          }
        }
        return false
      }
      if (ts.isElementAccessExpression(node)) {
        return (
          ts.isStringLiteral(node.argumentExpression) && HOT_MAPS.has(node.argumentExpression.text)
        )
      }
      if (ts.isIdentifier(node)) {
        if (HOT_MAPS.has(node.text) || tainted.has(node.text)) {
          return true
        }
        if (seen.has(node.text)) {
          return false
        }
        seen.add(node.text)
        const alias = mod.aliases.get(node.text)
        return alias ? hotMap(alias, seen) : false
      }
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node)
      ) {
        return hotMap(node.expression, seen)
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return hotMap(node.left, seen)
      }
      return false
    }
    function report(node) {
      const line = mod.source.getLineAndCharacterOfPosition(node.getStart(mod.source)).line + 1
      violations.add(
        `${rel}:${line}: ${name} enumerates a whole parking input; use the addressed owner or a named source resync.`
      )
    }
    function visit(node) {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        EFFECT_BOUNDARIES.has(`${rel}#${node.name.text}`)
      ) {
        return
      }
      if (ts.isForInStatement(node) && hotMap(node.expression)) {
        report(node)
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'Object' &&
          ENUMERATORS.has(callee.name.text) &&
          node.arguments.some((arg) => hotMap(arg)) &&
          !(callee.name.text === 'keys' && KEY_DIFFS.has(`${rel}#${name}`)) &&
          !COLD_RESYNCS.has(`${rel}#${name}`)
        ) {
          report(node)
        }
        if (ts.isIdentifier(callee)) {
          const target = mod.imports.get(callee.text) ?? { rel, name: callee.text }
          if (
            COLD_RESYNCS.has(`${target.rel}#${target.name}`) &&
            !isColdResyncCall(node, mod.source)
          ) {
            report(node)
          }
          if (!STORE_BOUNDARIES.has(target.rel)) {
            let targetModule = modules.get(target.rel)
            if (!targetModule) {
              modules.set(target.rel, (targetModule = readModule(root, target.rel)))
            }
            const called = targetModule.functions.get(target.name)
            const parameters = new Set()
            called?.parameters.forEach((parameter, index) => {
              if (
                ts.isIdentifier(parameter.name) &&
                node.arguments[index] &&
                hotMap(node.arguments[index])
              ) {
                parameters.add(parameter.name.text)
              }
            })
            if (called) {
              pending.push({ ...target, tainted: parameters })
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(fn.body)
  }
  return [...violations].sort()
}

function collectPublicCoverageViolations(root) {
  const rel = `${WATCHERS}parked-terminal-tab-coverage.ts`
  const { source } = readModule(root, rel)
  const privateNames = new Set([
    'fallbackParkedPaneCandidates',
    'resolveParkedTerminalPaneCandidates',
    'capturedCoversFallback'
  ])
  const violations = []
  for (const statement of source.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    const leaksDeclaration =
      exported && ts.isFunctionDeclaration(statement) && privateNames.has(statement.name?.text)
    const leaksNamedExport =
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) =>
        privateNames.has(element.propertyName?.text ?? element.name.text)
      )
    if (leaksDeclaration || leaksNamedExport) {
      violations.push(`${rel}: raw coverage derivation must stay private to its owner.`)
    }
  }
  return violations
}

export function main(root = process.cwd()) {
  const violations = [
    ...collectParkingOwnershipViolations(root),
    ...collectUnaddressedWrites(root),
    ...collectPublicCoverageViolations(root)
  ]
  for (const violation of violations) {
    console.error(violation)
  }
  if (violations.length) {
    return 1
  }
  console.log(
    'terminal-parking-ownership: addressed consumer paths contain no whole input enumeration'
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
