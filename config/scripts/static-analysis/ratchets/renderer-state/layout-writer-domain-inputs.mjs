import ts from 'typescript-api'

const DOMAIN_INPUT_SITES = new Map([
  [
    'src/main/workspace-surfaces/surface-host-profile-session.ts:surfaceSessionReplacements',
    'return'
  ],
  [
    'src/main/workspace-surfaces/surface-host-profile-session.ts:surfaceSessionBatchReplacements',
    'replacements.push'
  ],
  ['src/main/workspace-surfaces/surface-profile-save.ts:protectSurfaceProfileSave', 'output.push']
])

function isDomainInput(use, fileName, ownerOf) {
  const property = use.parent
  if (
    !ts.isPropertyAssignment(property) ||
    property.initializer !== use ||
    !(
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'domain'
    )
  ) {
    return false
  }
  const site = DOMAIN_INPUT_SITES.get(`${fileName}:${ownerOf(use)}`)
  const owner = property.parent.parent
  if (site === 'return') {
    return ts.isArrayLiteralExpression(owner) && ts.isReturnStatement(owner.parent)
  }
  return site !== undefined && ts.isCallExpression(owner) && owner.expression.getText() === site
}

function isProfileProjectionRead(use, fileName, ownerOf) {
  if (
    fileName !== 'src/main/workspace-surfaces/surface-profile-save.ts' ||
    ownerOf(use) !== 'protectSurfaceProfileSave'
  ) {
    return false
  }
  const parent = use.parent
  if (ts.isBinaryExpression(parent)) {
    return (
      parent.left.getText() === 'mutation.domain' &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        parent.operatorToken.kind
      )
    )
  }
  if (ts.isCallExpression(parent) && parent.arguments.includes(use)) {
    return ['readPayload', 'domains.has'].includes(parent.expression.getText())
  }
  const array = use.parent
  return (
    ts.isArrayLiteralExpression(array) &&
    ts.isPropertyAccessExpression(array.parent) &&
    array.parent.name.text === 'includes' &&
    ts.isCallExpression(array.parent.parent) &&
    array.parent.parent.arguments[0]?.getText() === 'mutation.domain'
  )
}

function isSelectRead(use) {
  const call = use.parent
  if (!ts.isCallExpression(call) || !call.arguments.includes(use)) {
    return false
  }
  const getter = call.expression
  if (!ts.isPropertyAccessExpression(getter) || getter.name.text !== 'get') {
    return false
  }
  const prepared = getter.expression
  return (
    ts.isCallExpression(prepared) &&
    ts.isPropertyAccessExpression(prepared.expression) &&
    prepared.expression.name.text === 'prepare' &&
    prepared.arguments[0] !== undefined &&
    ts.isStringLiteral(prepared.arguments[0]) &&
    /^SELECT\s/i.test(prepared.arguments[0].text)
  )
}

/** Only proven SELECT reads, dirty markers and these typed-owner inputs avoid the literal fallback. */
export function isReadKeyLiteral(node, fileName, ownerOf) {
  const isReadUse = (use) => {
    if (
      isDomainInput(use, fileName, ownerOf) ||
      isProfileProjectionRead(use, fileName, ownerOf) ||
      isSelectRead(use)
    ) {
      return true
    }
    const parent = use.parent
    return (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(use) &&
      ['runtime.dirtyProfileStateDomains.add', 'runtime.dirtyProfileStateDomains?.add'].includes(
        parent.expression.getText()
      )
    )
  }
  let value = node
  while (ts.isConditionalExpression(value.parent) && value.parent.condition !== value) {
    value = value.parent
  }
  if (isReadUse(value)) {
    return true
  }
  if (!ts.isVariableDeclaration(value.parent) || !ts.isIdentifier(value.parent.name)) {
    return false
  }
  const declaration = value.parent
  const name = declaration.name.text
  let found = false
  let readOnly = true
  const visit = (part) => {
    if (
      ts.isIdentifier(part) &&
      part.text === name &&
      part !== declaration.name &&
      !(ts.isPropertyAccessExpression(part.parent) && part.parent.name === part) &&
      !(ts.isPropertyAssignment(part.parent) && part.parent.name === part)
    ) {
      found = true
      if (!isReadUse(part)) {
        readOnly = false
      }
    }
    ts.forEachChild(part, visit)
  }
  let scope = declaration.parent
  while (scope.parent && !ts.isFunctionLike(scope)) {
    scope = scope.parent
  }
  visit(scope)
  return found && readOnly
}
