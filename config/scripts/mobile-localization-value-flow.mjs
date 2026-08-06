// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

import { destructuredLocalizationTargets } from './mobile-localization-destructuring-targets.mjs'

const ASSIGNMENT_KINDS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])
const LOGICAL_ASSIGNMENT_KINDS = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
])

function unwrapExpression(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrapExpression(node.expression)
  }
  return node
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
  return undefined
}

function memberParts(node) {
  const expression = unwrapExpression(node)
  if (ts.isPropertyAccessExpression(expression)) {
    return { object: expression.expression, propertyName: expression.name.text }
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return { object: expression.expression, propertyName: expression.argumentExpression.text }
  }
  return undefined
}

function statementContainer(node) {
  let current = node
  while (current.parent) {
    if (
      ts.isSourceFile(current.parent) ||
      ts.isBlock(current.parent) ||
      ts.isModuleBlock(current.parent) ||
      ts.isCaseBlock(current.parent) ||
      ts.isClassStaticBlockDeclaration(current.parent)
    ) {
      return { container: current.parent, statement: current }
    }
    current = current.parent
  }
  return undefined
}

function isConstBinding(binding) {
  const declaration = ts.isBindingElement(binding) ? binding.parent.parent : binding
  const declarationList = ts.isVariableDeclaration(declaration) ? declaration.parent : undefined
  return Boolean(
    declarationList &&
    ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & ts.NodeFlags.Const) !== 0
  )
}

function isOrderedBefore(write, use) {
  const writeStatement = statementContainer(write.node)
  const useStatement = statementContainer(use)
  return Boolean(
    writeStatement &&
    useStatement &&
    writeStatement.container === useStatement.container &&
    writeStatement.statement.end <= useStatement.statement.pos
  )
}

function isDefiniteBefore(write, use) {
  return !write.conditional && isOrderedBefore(write, use)
}

function functionOwner(node) {
  let current = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) {
      return current
    }
    current = current.parent
  }
  return undefined
}

function loopOwner(node) {
  let current = node.parent
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
    if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return current
    }
    current = current.parent
  }
  return undefined
}

function canReachUse(write, use, sourceFile, scopeOwners = new Set()) {
  if (write.position < use.getStart(sourceFile)) {
    return true
  }
  const useOwner = functionOwner(use)
  if (!useOwner || functionOwner(write.node) !== useOwner) {
    return Boolean(useOwner)
  }
  if (loopOwner(write.node) && loopOwner(write.node) === loopOwner(use)) {
    return true
  }
  return [...scopeOwners].some((owner) => owner !== useOwner)
}

export function createMobileLocalizationValueFlow(sourceFile, bindings) {
  const writes = new Map()
  const propertyWrites = new Map()
  const pendingPropertyWrites = []

  function addWrite(identifier, expression, node, propertyPath, operator, defaultExpression) {
    const binding = bindings.resolveBinding(identifier)
    if (!binding) {
      return
    }
    const entries = writes.get(binding) ?? []
    entries.push({
      conditional: LOGICAL_ASSIGNMENT_KINDS.has(operator),
      expression,
      node,
      operator,
      position: node.getStart(sourceFile),
      propertyPath,
      defaultExpression
    })
    writes.set(binding, entries)
  }

  function addTargetWrites(name, expression, node, operator) {
    const target = unwrapExpression(name)
    if (ts.isIdentifier(target)) {
      addWrite(target, expression, node, undefined, operator)
      return
    }
    for (const entry of destructuredLocalizationTargets(target)) {
      addWrite(
        entry.identifier,
        expression,
        node,
        entry.propertyPath,
        operator,
        entry.defaultExpression
      )
    }
  }

  function memberWriteTarget(node) {
    const member = memberParts(node)
    return member ? { ...member, target: unwrapExpression(node) } : undefined
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      addTargetWrites(node.name, node.initializer, node)
    } else if (ts.isBinaryExpression(node) && ASSIGNMENT_KINDS.has(node.operatorToken.kind)) {
      const memberTarget = memberWriteTarget(node.left)
      if (memberTarget) {
        pendingPropertyWrites.push({
          ...memberTarget,
          conditional: LOGICAL_ASSIGNMENT_KINDS.has(node.operatorToken.kind),
          expression: node.right,
          node,
          operator: node.operatorToken.kind,
          position: node.getStart(sourceFile)
        })
      } else {
        addTargetWrites(node.left, node.right, node, node.operatorToken.kind)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  for (const entries of writes.values()) {
    entries.sort((left, right) => left.position - right.position)
  }
  function staticValueState(node) {
    const expression = unwrapExpression(node)
    if (
      expression.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(expression) ||
      (ts.isIdentifier(expression) &&
        expression.text === 'undefined' &&
        !bindings.resolveBinding(expression))
    ) {
      return { nullish: true, truthy: false }
    }
    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
      return { nullish: false, truthy: true }
    }
    if (expression.kind === ts.SyntaxKind.FalseKeyword) {
      return { nullish: false, truthy: false }
    }
    if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return { nullish: false, truthy: expression.text.length > 0 }
    }
    if (ts.isNumericLiteral(expression)) {
      return { nullish: false, truthy: Number(expression.text) !== 0 }
    }
    if (ts.isBigIntLiteral(expression)) {
      return { nullish: false, truthy: expression.text !== '0n' }
    }
    if (
      ts.isArrowFunction(expression) ||
      ts.isFunctionExpression(expression) ||
      ts.isClassExpression(expression) ||
      ts.isObjectLiteralExpression(expression) ||
      ts.isArrayLiteralExpression(expression) ||
      ts.isNewExpression(expression)
    ) {
      return { nullish: false, truthy: true }
    }
    if (ts.isIdentifier(expression)) {
      const binding = bindings.resolveBinding(expression)
      if (binding && bindings.rootDescriptors?.has(binding)) {
        return { nullish: false, truthy: true }
      }
    }
    return { nullish: undefined, truthy: undefined }
  }

  function logicalWriteAction(operator, expressions, knownEmpty = false) {
    const values = expressions.length > 0 ? expressions : knownEmpty ? [undefined] : []
    const actions = new Set()
    for (const expression of values) {
      const state =
        expression === undefined ? { nullish: true, truthy: false } : staticValueState(expression)
      const applies =
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken
          ? state.nullish
          : operator === ts.SyntaxKind.BarBarEqualsToken
            ? state.truthy === undefined
              ? undefined
              : !state.truthy
            : state.truthy
      actions.add(applies === true ? 'assign' : applies === false ? 'keep' : 'unknown')
    }
    return actions.size === 1 ? [...actions][0] : 'unknown'
  }

  function isUninitializedBinding(binding) {
    return ts.isVariableDeclaration(binding) && binding.initializer === undefined
  }

  function selectedWrites(identifier, use, all) {
    const binding = bindings.resolveBinding(identifier)
    const entries = binding ? (writes.get(binding) ?? []) : []
    if (all || (binding && isConstBinding(binding))) {
      return entries
    }
    const available = entries.filter((entry) =>
      canReachUse(entry, use, sourceFile, new Set([functionOwner(binding)]))
    )
    let selected = []
    for (const entry of available) {
      const action = entry.conditional
        ? logicalWriteAction(
            entry.operator,
            selected.flatMap((write) => (write.propertyPath ? [] : [write.expression])),
            selected.length === 0 && isUninitializedBinding(binding)
          )
        : 'assign'
      if (!isOrderedBefore(entry, use)) {
        if (action !== 'keep') {
          selected.push(entry)
        }
        continue
      }
      if (!entry.conditional) {
        selected = [entry]
        continue
      }
      if (action === 'assign') {
        selected = [entry]
      } else if (action === 'unknown') {
        selected.push(entry)
      }
    }
    return selected
  }

  function locationKey(location) {
    return `${location.binding.pos}:${location.path.join('\0')}`
  }

  function objectLocations(node, use = node, seen = new Set(), all = false) {
    const expression = unwrapExpression(node)
    if (ts.isIdentifier(expression)) {
      const binding = bindings.resolveBinding(expression)
      if (!binding) {
        return []
      }
      const direct = [{ binding, path: [] }]
      if (seen.has(binding)) {
        return direct
      }
      const nextSeen = new Set(seen).add(binding)
      const sources = selectedWrites(expression, use, all)
      const resolved = sources.flatMap((source) => {
        const locations = objectLocations(source.expression, source.node, nextSeen, all)
        return source.propertyPath
          ? locations.map((location) => ({
              binding: location.binding,
              path: [...location.path, ...source.propertyPath]
            }))
          : locations
      })
      const locations = resolved.length > 0 ? resolved : direct
      return [...new Map(locations.map((location) => [locationKey(location), location])).values()]
    }
    if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
      return [{ binding: expression, path: [] }]
    }
    const member = memberParts(expression)
    if (!member) {
      return []
    }
    return objectLocations(member.object, use, seen, all).map((location) => ({
      binding: location.binding,
      path: [...location.path, member.propertyName]
    }))
  }

  function indexedPropertyWrites(location) {
    const byPath = propertyWrites.get(location.binding) ?? new Map()
    propertyWrites.set(location.binding, byPath)
    const key = location.path.join('\0')
    const entries = byPath.get(key) ?? []
    byPath.set(key, entries)
    return entries
  }

  for (const entry of pendingPropertyWrites) {
    const targetLocations = objectLocations(entry.object, entry.node).map((location) => ({
      binding: location.binding,
      path: [...location.path, entry.propertyName]
    }))
    const rightMember = memberParts(entry.expression)
    const rightLocations = rightMember
      ? objectLocations(rightMember.object, entry.node).map((location) => ({
          binding: location.binding,
          path: [...location.path, rightMember.propertyName]
        }))
      : []
    const rightKeys = new Set(rightLocations.map(locationKey))
    const selfAssignment =
      targetLocations.length === 1 &&
      rightLocations.length === 1 &&
      rightKeys.has(locationKey(targetLocations[0]))
    const indexed = {
      ...entry,
      scopeOwners: new Set(targetLocations.map((location) => functionOwner(location.binding))),
      selfAssignment
    }
    for (const location of targetLocations) {
      indexedPropertyWrites(location).push(indexed)
    }
  }
  for (const byPath of propertyWrites.values()) {
    for (const entries of byPath.values()) {
      entries.sort((left, right) => left.position - right.position)
    }
  }

  function propertyWriteEntries(node, propertyName, use, all) {
    const entries = objectLocations(node, use, new Set(), all).flatMap((location) => {
      const key = [...location.path, propertyName].join('\0')
      return propertyWrites.get(location.binding)?.get(key) ?? []
    })
    return [
      ...new Set(
        entries.filter(
          (entry) =>
            !entry.selfAssignment && (all || canReachUse(entry, use, sourceFile, entry.scopeOwners))
        )
      )
    ].sort((left, right) => left.position - right.position)
  }

  function applyPropertyWrites(resolved, known, node, propertyName, use, all) {
    for (const entry of propertyWriteEntries(node, propertyName, use, all)) {
      if (all) {
        resolved.push(entry.expression)
        continue
      }
      const action = entry.conditional
        ? logicalWriteAction(entry.operator, resolved, known && resolved.length === 0)
        : 'assign'
      if (!isOrderedBefore(entry, use)) {
        if (action !== 'keep') {
          resolved.push(entry.expression)
        }
        continue
      }
      if (action === 'assign') {
        resolved.splice(0, resolved.length, entry.expression)
        known = true
      } else if (action === 'unknown') {
        resolved.push(entry.expression)
      }
    }
    return known
  }

  function propertyPathValues(node, propertyPath, use = node, seen = new Set(), all = false) {
    let sources = [{ expression: node, use }]
    let known = true
    for (const propertyName of propertyPath) {
      const next = []
      for (const source of sources) {
        const values = propertyValues(
          source.expression,
          propertyName,
          source.use,
          new Set(seen),
          all
        )
        if (values === undefined) {
          known = false
          continue
        }
        next.push(...values.map((expression) => ({ expression, use: expression })))
      }
      sources = next
    }
    const values = sources.map((source) => source.expression)
    return known || (all && values.length > 0) ? values : undefined
  }

  function propertyValues(node, propertyName, use = node, seen = new Set(), all = false) {
    const expression = unwrapExpression(node)
    if (ts.isIdentifier(expression)) {
      const binding = bindings.resolveBinding(expression)
      if (!binding || seen.has(binding)) {
        return undefined
      }
      const nextSeen = new Set(seen).add(binding)
      const sources = valueSources(expression, use, all)
      const resolved = []
      let known = true
      for (const source of sources) {
        const values = source.propertyPath
          ? propertyPathValues(source.expression, source.propertyPath, source.node, nextSeen, all)
          : [source.expression]
        if (values === undefined) {
          known = false
          continue
        }
        for (const value of values) {
          const matches = propertyValues(value, propertyName, source.node, nextSeen, all)
          if (matches === undefined) {
            known = false
          } else {
            resolved.push(...matches)
          }
        }
      }
      known = applyPropertyWrites(resolved, known, expression, propertyName, use, all)
      return known || (all && resolved.length > 0) ? resolved : undefined
    }
    const member = memberParts(expression)
    if (member) {
      const objectValues = propertyValues(
        member.object,
        member.propertyName,
        use,
        new Set(seen),
        all
      )
      const resolved = []
      let known = objectValues !== undefined
      for (const value of objectValues ?? []) {
        const matches = propertyValues(value, propertyName, value, new Set(seen), all)
        if (matches === undefined) {
          known = false
        } else {
          resolved.push(...matches)
        }
      }
      known = applyPropertyWrites(resolved, known, expression, propertyName, use, all)
      return known || (all && resolved.length > 0) ? resolved : undefined
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const index = Number(propertyName)
      if (!Number.isInteger(index) || index < 0 || index >= expression.elements.length) {
        return []
      }
      const element = expression.elements[index]
      return ts.isOmittedExpression(element) || ts.isSpreadElement(element) ? [] : [element]
    }
    if (!ts.isObjectLiteralExpression(expression)) {
      return undefined
    }
    for (const property of expression.properties.toReversed()) {
      if (ts.isSpreadAssignment(property)) {
        const spreadValues = propertyValues(
          property.expression,
          propertyName,
          property.expression,
          new Set(seen),
          all
        )
        if (spreadValues === undefined || spreadValues.length > 0) {
          return spreadValues
        }
        continue
      }
      const name = propertyNameText(property.name)
      if (name === undefined) {
        return undefined
      }
      if (name !== propertyName) {
        continue
      }
      if (ts.isPropertyAssignment(property)) {
        return [property.initializer]
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name]
      }
      if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property)) {
        return [property]
      }
      return undefined
    }
    return []
  }

  function materializeWrites(entries, use, seen) {
    const values = []
    for (const entry of entries) {
      if (!entry.propertyPath) {
        values.push(entry.expression)
        continue
      }
      const matches = propertyPathValues(
        entry.expression,
        entry.propertyPath,
        entry.node,
        new Set(seen)
      )
      if (matches === undefined) {
        return undefined
      }
      values.push(
        ...(matches.length === 0 && entry.defaultExpression ? [entry.defaultExpression] : matches)
      )
    }
    return values
  }

  function valueExpressions(identifier, use = identifier, seen = new Set()) {
    return materializeWrites(selectedWrites(identifier, use, false), use, seen)
  }

  function allValueExpressions(identifier, use = identifier, seen = new Set()) {
    return materializeWrites(selectedWrites(identifier, use, true), use, seen)
  }

  function valueSources(identifier, use = identifier, all = false) {
    return selectedWrites(identifier, use, all)
  }

  function stableBindingWrite(binding) {
    let source
    for (const entry of writes.get(binding) ?? []) {
      if (!entry.conditional) {
        if (source) {
          return undefined
        }
        source = entry
        continue
      }
      if (
        !source ||
        source.propertyPath ||
        logicalWriteAction(entry.operator, [source.expression]) !== 'keep'
      ) {
        return undefined
      }
    }
    return source
  }

  function bindingWrites() {
    return writes.entries()
  }

  function writeReachesUse(write, use) {
    return isDefiniteBefore(write, use)
  }

  return {
    allValueExpressions,
    bindingWrites,
    isImmutableBinding: isConstBinding,
    propertyPathValues,
    propertyValues,
    stableBindingWrite,
    unwrapExpression,
    valueExpressions,
    valueSources,
    writeReachesUse
  }
}
