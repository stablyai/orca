import ts from 'typescript-api'
import { REFRESH_CONTRACT, FORGET_CONTRACT } from './terminal-route-invalidation-contract.mjs'

const ROUTE_DOMAINS = 'src/renderer/src/store/terminals/terminal-membership-route-domains.ts'
const READER = 'getSingleFocusedRuntimeEnvironmentId'

function parse(source) {
  return ts.createSourceFile('observer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
function nodes(root, predicate) {
  const found = []
  function visit(node) {
    if (predicate(node)) {
      found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}
function tokens(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source
  )
  const result = []
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    result.push(scanner.getTokenText())
  }
  return JSON.stringify(result)
}
function shape(node, source) {
  return node && tokens(node.getText()) === tokens(source)
}
function references(root, name) {
  return nodes(root, (node) => ts.isIdentifier(node) && node.text === name)
}
function declaration(root, name) {
  const matches = nodes(
    root,
    (node) =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
  )
  return matches.length === 1 ? matches[0] : null
}
function isConst(node) {
  return (
    node &&
    ts.isVariableDeclarationList(node.parent) &&
    Boolean(node.parent.flags & ts.NodeFlags.Const)
  )
}
function imported(file, name, module) {
  const matches = file.statements.filter(
    (node) =>
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === module &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (entry) => entry.name.text === name && !entry.propertyName && !entry.isTypeOnly
      )
  )
  return matches.length === 1
}
function onlyReferences(root, name, allowed) {
  const expected = new Set(allowed.flatMap((node) => (node ? references(node, name) : [])))
  return references(root, name).every((node) => expected.has(node))
}

// Recognize only dependency observation whose sole sink refreshes existing setup domains.
// Every binding/use check fails closed; ordinary reader discovery still sees the original source.
export function focusInvalidationReaderSpans(rel, source) {
  if (rel !== ROUTE_DOMAINS) {
    return []
  }
  const file = parse(source)
  if (
    file.parseDiagnostics.length ||
    !imported(file, READER, '@/lib/workspace/ownership/single-runtime-legacy-owner') ||
    !imported(
      file,
      'resolveTerminalPtyOwner',
      '@/lib/workspace/ownership/terminal-worktree-route'
    ) ||
    !imported(
      file,
      'isEphemeralSetupTerminalWorktreeId',
      '../../../../shared/ephemeral-setup-terminal-worktree-id'
    )
  ) {
    return []
  }
  const factories = file.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'createTerminalMembershipRouteDomains'
  )
  if (factories.length !== 1) {
    return []
  }
  const factory = factories[0]
  const returned = factory.body.statements.filter(ts.isReturnStatement)
  if (returned.length !== 1 || !ts.isObjectLiteralExpression(returned[0].expression)) {
    return []
  }
  const accepts = returned[0].expression.properties.filter(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(file) === 'accept'
  )
  if (accepts.length !== 1) {
    return []
  }
  const accept = accepts[0]
  if (accept.parameters.map((node) => node.name.getText(file)).join(',') !== 'previous,state') {
    return []
  }
  const setup = declaration(factory, 'setups')
  const affected = declaration(factory, 'affected')
  const addAll = declaration(factory, 'addAll')
  if (
    !isConst(setup) ||
    !isConst(affected) ||
    !isConst(addAll) ||
    !shape(setup.parent.parent, 'const setups = new Set<string>()') ||
    !shape(affected.parent.parent, 'const affected = new Set<string>()') ||
    !shape(
      addAll.parent.parent,
      `const addAll = (ids: Iterable<string>) => {
      for (const id of ids) { affected.add(id) }
    }`
    ) ||
    !factory.body.statements.includes(setup.parent.parent) ||
    !accept.body.statements.includes(affected.parent.parent) ||
    !accept.body.statements.includes(addAll.parent.parent)
  ) {
    return []
  }
  const observers = accept.body.statements.filter((node) =>
    shape(
      node,
      `if (
    previous.settings !== state.settings || previous.runtimeEnvironments !== state.runtimeEnvironments
  ) {
    if (${READER}(previous) !== ${READER}(state)) { addAll(setups) }
  }`
    )
  )
  if (observers.length !== 1) {
    return []
  }
  const observer = observers[0]
  const refreshes = factory.body.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'refresh'
  )
  const forgets = factory.body.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'forget'
  )
  if (refreshes.length !== 1 || forgets.length !== 1) {
    return []
  }
  const refresh = refreshes[0],
    forget = forgets[0]
  if (!shape(refresh, REFRESH_CONTRACT) || !shape(forget, FORGET_CONTRACT)) {
    return []
  }
  if (
    refresh.parameters.map((node) => node.name.getText(file)).join(',') !== 'state,workspace' ||
    forget.parameters.map((node) => node.name.getText(file)).join(',') !== 'workspace'
  ) {
    return []
  }
  const registration = refresh.body.statements.find(
    (node) => ts.isIfStatement(node) && node.expression.getText(file) === 'setup'
  )
  const setupPredicate = declaration(refresh, 'setup')
  const owner = declaration(refresh, 'owner')
  const deletion = forget.body.statements.find((node) => shape(node, 'setups.delete(workspace)'))
  const refreshLoop = accept.body.statements.find((node) =>
    shape(node, 'for (const id of affected) { refresh(state, id) }')
  )
  if (
    !registration ||
    !shape(registration.thenStatement, '{ setups.add(workspace) }') ||
    !isConst(setupPredicate) ||
    !shape(
      setupPredicate.parent.parent,
      'const setup = isEphemeralSetupTerminalWorktreeId(workspace)'
    ) ||
    !refresh.body.statements.includes(setupPredicate.parent.parent) ||
    !isConst(owner) ||
    !shape(
      owner.parent.parent,
      "const owner = resolveTerminalPtyOwner(state, workspace, 'spawn')"
    ) ||
    !refresh.body.statements.includes(owner.parent.parent) ||
    !deletion ||
    !refreshLoop
  ) {
    return []
  }
  // No escaping/replaced dependency sets, callbacks or shadowed bindings.
  if (
    !onlyReferences(file, 'setups', [setup, registration.thenStatement, deletion, observer]) ||
    !onlyReferences(file, 'addAll', [
      addAll,
      ...nodes(
        accept,
        (node) =>
          ts.isCallExpression(node) &&
          node.expression.getText(file) === 'addAll' &&
          node.arguments.length === 1 &&
          ts.isExpressionStatement(node.parent)
      ).map((node) => node.expression)
    ])
  ) {
    return []
  }
  const allowedAffected = [affected, refreshLoop]
  for (const node of references(file, 'affected')) {
    const parent = node.parent
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === 'add' &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      parent.parent.arguments.length === 1 &&
      ts.isExpressionStatement(parent.parent.parent)
    ) {
      allowedAffected.push(node)
    }
    if (
      ts.isReturnStatement(parent) &&
      parent.expression === node &&
      (parent.parent === accept.body ||
        (ts.isBlock(parent.parent) &&
          ts.isIfStatement(parent.parent.parent) &&
          parent.parent.parent.parent === accept.body &&
          parent.parent.parent.expression.getText(file) === '!previous'))
    ) {
      allowedAffected.push(node)
    }
  }
  if (!onlyReferences(file, 'affected', allowedAffected)) {
    return []
  }
  // A redeclaration of the imported reader/predicate/resolver or refresh is never sanctioned.
  for (const name of [
    READER,
    'isEphemeralSetupTerminalWorktreeId',
    'resolveTerminalPtyOwner',
    'refresh'
  ]) {
    if (
      nodes(
        file,
        (node) =>
          (ts.isVariableDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isBindingElement(node)) &&
          node.name?.getText(file) === name
      ).some((node) => node !== refresh)
    ) {
      return []
    }
  }
  const comparison = observer.thenStatement.statements[0].expression
  return [comparison.left.expression, comparison.right.expression].map((node) => ({
    start: node.getStart(file),
    end: node.end
  }))
}

export function omitFocusInvalidationReaderUses(rel, source) {
  const spans = focusInvalidationReaderSpans(rel, source)
  let result = source
  for (const { start, end } of spans.toReversed()) {
    result = result.slice(0, start) + ' '.repeat(end - start) + result.slice(end)
  }
  return result
}
