import ts from 'typescript-api'

function findStoreSetter(object, scope) {
  const properties = new Map(object.properties.map((property) => [property.name?.text, property]))
  if (!properties.has('getState') || !properties.has('subscribe')) {
    return
  }
  const setter = properties.get('setState')
  if (!setter) {
    return
  }
  if (ts.isMethodDeclaration(setter)) {
    return setter
  }
  const value = ts.isPropertyAssignment(setter) ? setter.initializer : setter.name
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    return value
  }
  if (!ts.isIdentifier(value)) {
    return
  }
  for (const statement of scope.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === value.text) {
      return statement
    }
    if (ts.isVariableStatement(statement)) {
      const binding = statement.declarationList.declarations.find(
        ({ name }) => ts.isIdentifier(name) && name.text === value.text
      )
      if (binding?.initializer) {
        return binding.initializer
      }
    }
  }
}

function readNotification(node, file) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
    return
  }
  const { expression: method } = node
  if (
    !ts.isPropertyAccessExpression(method) ||
    method.name.text !== 'forEach' ||
    !ts.isIdentifier(method.expression)
  ) {
    return
  }
  const callback = ts.skipParentheses(node.arguments[0])
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return
  }
  const listener = callback.parameters[0]?.name
  let call = callback.body
  if (ts.isBlock(call) && call.statements.length === 1) {
    const [statement] = call.statements
    if (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)) {
      call = statement.expression
    }
  }
  if (
    !listener ||
    !ts.isIdentifier(listener) ||
    !call ||
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== listener.text ||
    call.arguments.length !== 2 ||
    !call.arguments.every(ts.isIdentifier)
  ) {
    return
  }
  const [next, previous] = call.arguments
  return {
    start: node.getStart(file),
    end: node.end,
    listeners: method.expression.getText(file),
    next: next.getText(file),
    previous: previous.getText(file)
  }
}

export function locateStoreNotifications(source) {
  if (
    !source.includes('setState') ||
    !source.includes('subscribe') ||
    !source.includes('forEach')
  ) {
    return []
  }
  const file = ts.createSourceFile(
    'renderer.js',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  )
  const setters = new Set()
  const visit = (node, scope) => {
    if (ts.isBlock(node)) {
      scope = node
    }
    if (ts.isObjectLiteralExpression(node)) {
      const setter = findStoreSetter(node, scope)
      if (setter && ts.isFunctionLike(setter)) {
        setters.add(setter)
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope))
  }
  visit(file, file)

  // Anchor the search to the store API so other two-argument fanout loops do not count as publications.
  const notifications = []
  const visitSetter = (node) => {
    if (!ts.isFunctionLike(node)) {
      const notification = readNotification(node, file)
      if (notification) {
        notifications.push(notification)
      }
      ts.forEachChild(node, visitSetter)
    }
  }
  for (const setter of setters) {
    if (setter.body) {
      visitSetter(setter.body)
    }
  }
  return notifications
}
