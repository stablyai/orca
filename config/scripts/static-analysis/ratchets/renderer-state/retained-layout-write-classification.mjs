import ts from 'typescript-api'

const PATCH_FILE =
  'src/main/persistence/loading-store/workspace-sessions/terminal-session-cleanup.ts'
const HYDRATION_FILE = 'src/renderer/src/store/terminals/workspace-terminal-hydration.ts'
const INSTALLER_FILE =
  'src/renderer/src/store/terminals/retained-terminal-destination-installation.ts'

function ancestor(node, predicate) {
  for (let current = node.parent; current; current = current.parent) {
    if (predicate(current)) {
      return current
    }
  }
  return null
}

function identifier(node, name) {
  return node && ts.isIdentifier(node) && node.text === name
}

function member(node, receiver, name) {
  return (
    node &&
    ts.isPropertyAccessExpression(node) &&
    identifier(node.expression, receiver) &&
    node.name.text === name
  )
}

function namedFunction(node, name) {
  return ancestor(
    node,
    (parent) =>
      ts.isFunctionDeclaration(parent) &&
      ts.isSourceFile(parent.parent) &&
      identifier(parent.name, name)
  )
}

function spread(node, name) {
  return node && ts.isSpreadAssignment(node) && identifier(node.expression, name)
}

function property(node, name) {
  return ts.isPropertyAssignment(node) && identifier(node.name, name)
}

function declarations(owner, name) {
  const found = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && identifier(node.name, name)) {
      found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return found
}

function patchRole(node) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(node.left) ||
    !identifier(node.left.expression, 'next')
  ) {
    return null
  }
  const field = node.left.name.text
  if (!['unifiedTabs', 'tabGroups', 'tabGroupLayouts'].includes(field)) {
    return null
  }
  const owner = namedFunction(node, 'prepareWorkspaceSessionTopologyPatch')
  if (!owner) {
    return null
  }
  const locals = declarations(owner, 'next')
  const clone = locals[0]?.initializer
  if (
    locals.length !== 1 ||
    (locals[0].parent.flags & ts.NodeFlags.Const) === 0 ||
    locals[0].parent.parent.parent !== owner.body ||
    !clone ||
    !ts.isObjectLiteralExpression(clone) ||
    clone.properties.length !== 1 ||
    !spread(clone.properties[0], 'patch')
  ) {
    return null
  }
  const call = node.right
  if (
    !ts.isCallExpression(call) ||
    !identifier(call.expression, 'reuseTopologyBuckets') ||
    call.arguments.length !== 3 ||
    !member(call.arguments[0], 'patch', field) ||
    !member(call.arguments[1], 'prior', field) ||
    !identifier(call.arguments[2], 'worktreeIds')
  ) {
    return null
  }
  const statement = node.parent
  const block = statement.parent
  const condition = block.parent
  if (
    !ts.isExpressionStatement(statement) ||
    !ts.isBlock(block) ||
    !ts.isIfStatement(condition) ||
    condition.thenStatement !== block ||
    condition.parent !== owner.body
  ) {
    return null
  }
  const guard = condition.expression
  if (
    !ts.isCallExpression(guard) ||
    !member(guard.expression, 'Object', 'hasOwn') ||
    guard.arguments.length !== 2 ||
    !identifier(guard.arguments[0], 'patch') ||
    !ts.isStringLiteral(guard.arguments[1]) ||
    guard.arguments[1].text !== field
  ) {
    return null
  }
  return `patch-construction:${field}`
}

function cohortRole(node) {
  if (
    !property(node, 'groupsByWorktree') ||
    !namedFunction(node, 'createWorkspaceTerminalHydrationActions')
  ) {
    return null
  }
  const object = node.parent
  const call = object.parent
  if (
    !ts.isObjectLiteralExpression(object) ||
    object.properties.length !== 3 ||
    !spread(object.properties[0], 's') ||
    !spread(object.properties[1], 'hydrated') ||
    object.properties[2] !== node ||
    !ts.isCallExpression(call) ||
    call.arguments.length !== 1 ||
    call.arguments[0] !== object ||
    !ts.isExpressionStatement(call.parent)
  ) {
    return null
  }
  const target = call.expression
  if (
    !ts.isPropertyAccessExpression(target) ||
    target.name.text !== 'capture' ||
    !member(target.expression, 's', 'terminalStartupAttempt')
  ) {
    return null
  }
  const value = node.initializer
  if (
    !ts.isBinaryExpression(value) ||
    value.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !member(value.left, 'session', 'tabGroups') ||
    !member(value.right, 's', 'groupsByWorktree')
  ) {
    return null
  }
  const guard = call.parent.parent.parent
  if (
    !ts.isIfStatement(guard) ||
    !ts.isPrefixUnaryExpression(guard.expression) ||
    guard.expression.operator !== ts.SyntaxKind.ExclamationToken ||
    !member(guard.expression.operand, 'options', 'replaceWorkspaceKeys')
  ) {
    return null
  }
  return 'cohort-read:groupsByWorktree'
}

function installerCallback(node) {
  const callback = ancestor(node, ts.isArrowFunction)
  const call = callback?.parent
  const owner = namedFunction(node, 'installRetainedTerminalDestination')
  if (
    !owner ||
    !callback ||
    callback.parameters.length !== 1 ||
    !identifier(callback.parameters[0].name, 'state') ||
    !ts.isCallExpression(call) ||
    !member(call.expression, 'useAppStore', 'setState') ||
    call.arguments.length !== 1 ||
    call.arguments[0] !== callback ||
    call.parent.parent !== owner.body
  ) {
    return null
  }
  const calls = []
  const visit = (child) => {
    if (ts.isCallExpression(child) && member(child.expression, 'useAppStore', 'setState')) {
      calls.push(child)
    }
    ts.forEachChild(child, visit)
  }
  visit(owner)
  return calls.length === 1 ? callback : null
}

function resultObject(node, callback) {
  if (!node || !ts.isObjectLiteralExpression(node) || !ts.isReturnStatement(node.parent)) {
    return false
  }
  return node.parent.parent === callback.body
}

function resultProperty(node, callback, conditional) {
  const object = node.parent
  if (!ts.isObjectLiteralExpression(object)) {
    return false
  }
  if (!conditional) {
    return resultObject(object, callback)
  }
  const choice = object.parent
  return (
    ts.isConditionalExpression(choice) &&
    choice.whenFalse === object &&
    identifier(choice.condition, conditional) &&
    ts.isObjectLiteralExpression(choice.whenTrue) &&
    choice.whenTrue.properties.length === 0 &&
    ts.isParenthesizedExpression(choice.parent) &&
    ts.isSpreadAssignment(choice.parent.parent) &&
    resultObject(choice.parent.parent.parent, callback)
  )
}

function addressedValue(node, field, key, reducer) {
  const call = node.initializer
  if (
    !ts.isCallExpression(call) ||
    !identifier(call.expression, reducer) ||
    call.arguments.length !== 2 ||
    !member(call.arguments[0], 'state', field)
  ) {
    return null
  }
  const entries = call.arguments[1]
  const entry =
    ts.isArrayLiteralExpression(entries) && entries.elements.length === 1 && entries.elements[0]
  if (!entry || !ts.isArrayLiteralExpression(entry) || entry.elements.length !== 2) {
    return null
  }
  const address = entry.elements[0]
  if (!(key === 'tab' ? member(address, 'tab', 'id') : identifier(address, 'worktreeId'))) {
    return null
  }
  return entry.elements[1]
}

function appended(value, prior) {
  return (
    ts.isArrayLiteralExpression(value) &&
    value.elements.length === 2 &&
    ts.isSpreadElement(value.elements[0]) &&
    identifier(value.elements[0].expression, prior)
  )
}

function shorthand(node, name) {
  return ts.isShorthandPropertyAssignment(node) && identifier(node.name, name)
}

function initialized(node, name, match) {
  return property(node, name) && match(node.initializer)
}

function emptyArray(node) {
  return ts.isArrayLiteralExpression(node) && node.elements.length === 0
}

function missingGroup(node) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.length === 5 &&
    ts.isSpreadAssignment(node.properties[0]) &&
    ts.isNonNullExpression(node.properties[0].expression) &&
    identifier(node.properties[0].expression.expression, 'group') &&
    initialized(node.properties[1], 'id', (value) => identifier(value, 'targetGroupId')) &&
    initialized(node.properties[2], 'tabOrder', emptyArray) &&
    initialized(
      node.properties[3],
      'activeTabId',
      (value) => value.kind === ts.SyntaxKind.NullKeyword
    ) &&
    initialized(node.properties[4], 'recentTabIds', emptyArray)
  )
}

function installedGroup(node) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.length === 3 &&
    spread(node.properties[0], 'nextGroup') &&
    shorthand(node.properties[1], 'tabOrder') &&
    initialized(node.properties[2], 'activeTabId', (value) => identifier(value, 'unifiedId'))
  )
}

function unifiedRow(node) {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 12) {
    return false
  }
  const fields = node.properties
  const tabField = (index, name, source = name) =>
    initialized(fields[index], name, (value) => member(value, 'tab', source))
  const contentType = fields[4]
  const value = ts.isPropertyAssignment(contentType) && contentType.initializer
  const mode = fields[11]
  const choice = ts.isSpreadAssignment(mode) && mode.expression
  return (
    tabField(0, 'id') &&
    tabField(1, 'entityId', 'id') &&
    initialized(fields[2], 'groupId', (entry) => identifier(entry, 'targetGroupId')) &&
    shorthand(fields[3], 'worktreeId') &&
    property(contentType, 'contentType') &&
    ts.isAsExpression(value) &&
    ts.isStringLiteral(value.expression) &&
    value.expression.text === 'terminal' &&
    ts.isTypeReferenceNode(value.type) &&
    identifier(value.type.typeName, 'const') &&
    initialized(fields[5], 'executionHostId', (entry) =>
      member(entry, 'start', 'executionHostId')
    ) &&
    tabField(6, 'label', 'title') &&
    tabField(7, 'customLabel', 'customTitle') &&
    tabField(8, 'color') &&
    initialized(
      fields[9],
      'sortOrder',
      (entry) =>
        ts.isCallExpression(entry) &&
        member(entry.expression, 'tabOrder', 'indexOf') &&
        entry.arguments.length === 1 &&
        identifier(entry.arguments[0], 'unifiedId')
    ) &&
    tabField(10, 'createdAt') &&
    ts.isParenthesizedExpression(choice) &&
    ts.isConditionalExpression(choice.expression) &&
    member(choice.expression.condition, 'tab', 'viewMode') &&
    ts.isObjectLiteralExpression(choice.expression.whenTrue) &&
    choice.expression.whenTrue.properties.length === 1 &&
    initialized(choice.expression.whenTrue.properties[0], 'viewMode', (entry) =>
      member(entry, 'tab', 'viewMode')
    ) &&
    ts.isObjectLiteralExpression(choice.expression.whenFalse) &&
    choice.expression.whenFalse.properties.length === 0
  )
}

function existingGroupUpdate(call) {
  if (
    !ts.isCallExpression(call) ||
    !member(call.expression, 'groups', 'map') ||
    call.arguments.length !== 1
  ) {
    return false
  }
  const callback = call.arguments[0]
  if (
    !ts.isArrowFunction(callback) ||
    callback.parameters.length !== 1 ||
    !identifier(callback.parameters[0].name, 'row')
  ) {
    return false
  }
  const body = ts.isParenthesizedExpression(callback.body)
    ? callback.body.expression
    : callback.body
  if (!ts.isConditionalExpression(body) || !ts.isBinaryExpression(body.condition)) {
    return false
  }
  return (
    body.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    member(body.condition.left, 'row', 'id') &&
    identifier(body.condition.right, 'targetGroupId') &&
    ts.isObjectLiteralExpression(body.whenTrue) &&
    body.whenTrue.properties.length === 2 &&
    spread(body.whenTrue.properties[0], 'row') &&
    shorthand(body.whenTrue.properties[1], 'tabOrder') &&
    identifier(body.whenFalse, 'row')
  )
}

function installerRole(node) {
  if (!ts.isPropertyAssignment(node)) {
    return null
  }
  const callback = installerCallback(node)
  if (!callback) {
    return null
  }
  const field = ts.isIdentifier(node.name) ? node.name.text : null
  const roles = {
    terminalLayoutsByTabId: ['tab', 'replaceRecordEntries', null],
    tabsByWorktree: ['workspace', 'replaceTabBuckets', 'currentTab'],
    ptyIdsByTabId: ['tab', 'replaceRecordEntries', 'currentTab'],
    unifiedTabsByWorktree: ['workspace', 'replaceTabBuckets', 'existingUnified'],
    groupsByWorktree: ['workspace', 'replaceRecordEntries', null],
    layoutByWorktree: ['workspace', 'replaceRecordEntries', null]
  }
  if (roles[field]) {
    const [key, reducer, condition] = roles[field]
    if (!resultProperty(node, callback, condition)) {
      return null
    }
    const value = addressedValue(node, field, key, reducer)
    if (!value) {
      return null
    }
    const valid =
      field === 'terminalLayoutsByTabId'
        ? identifier(value, 'nextLayout')
        : field === 'layoutByWorktree'
          ? identifier(value, 'nextGroupLayout')
          : field === 'ptyIdsByTabId'
            ? ts.isArrayLiteralExpression(value) && value.elements.length === 0
            : field === 'tabsByWorktree'
              ? appended(value, 'tabs') && identifier(value.elements[1], 'tab')
              : field === 'unifiedTabsByWorktree'
                ? appended(value, 'unified') && unifiedRow(value.elements[1])
                : ts.isConditionalExpression(value) &&
                  identifier(value.condition, 'targetGroup') &&
                  existingGroupUpdate(value.whenTrue) &&
                  appended(value.whenFalse, 'groups') &&
                  installedGroup(value.whenFalse.elements[1])
    return valid ? `retained-publisher:${field}` : null
  }
  if (field !== 'activeTabId') {
    return null
  }
  const object = node.parent
  if (!ts.isObjectLiteralExpression(object)) {
    return null
  }
  const parent = object.parent
  if (
    node.initializer.kind === ts.SyntaxKind.NullKeyword &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    parent.right === object &&
    identifier(parent.left, 'targetGroup') &&
    ts.isVariableDeclaration(parent.parent) &&
    identifier(parent.parent.name, 'nextGroup') &&
    parent.parent.parent.parent.parent === callback.body &&
    missingGroup(object)
  ) {
    return 'retained-publisher:missing-group-selection'
  }
  if (
    !identifier(node.initializer, 'unifiedId') ||
    !appended(parent, 'groups') ||
    parent.elements[1] !== object ||
    !installedGroup(object) ||
    object.properties[2] !== node ||
    !ts.isConditionalExpression(parent.parent) ||
    parent.parent.whenFalse !== parent
  ) {
    return null
  }
  const enclosing = ancestor(parent, (candidate) => property(candidate, 'groupsByWorktree'))
  return enclosing && installerRole(enclosing) === 'retained-publisher:groupsByWorktree'
    ? 'retained-publisher:installed-group-selection'
    : null
}

/** Finite addressed projection roles; raw census remains available and extra sites stay counted. */
export function classifyRetainedLayoutSites(sites, ratchet, fileName) {
  const classified = new Map()
  const used = new Set()
  for (const node of sites) {
    const role =
      ratchet.id === 'main' && fileName === PATCH_FILE
        ? patchRole(node)
        : ratchet.id === 'renderer' && fileName === HYDRATION_FILE
          ? cohortRole(node)
          : ratchet.id === 'renderer' && fileName === INSTALLER_FILE
            ? installerRole(node)
            : null
    if (role && !used.has(role)) {
      used.add(role)
      classified.set(node, role)
    }
  }
  return classified
}
