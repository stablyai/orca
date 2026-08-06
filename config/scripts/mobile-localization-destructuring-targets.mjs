// TypeScript 7 is a native CLI; AST consumers still need the legacy JavaScript API.
import ts from 'typescript-api'

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

export function destructuredLocalizationTargets(name, path = [], defaultExpression) {
  const target = unwrapExpression(name)
  if (ts.isIdentifier(target)) {
    return [{ defaultExpression, identifier: target, propertyPath: path }]
  }
  if (ts.isObjectBindingPattern(target)) {
    return target.elements.flatMap((element) => {
      if (element.dotDotDotToken) {
        return []
      }
      const propertyName = propertyNameText(element.propertyName ?? element.name)
      return propertyName
        ? destructuredLocalizationTargets(
            element.name,
            [...path, propertyName],
            element.initializer ?? defaultExpression
          )
        : []
    })
  }
  if (ts.isArrayBindingPattern(target)) {
    return target.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element) || element.dotDotDotToken) {
        return []
      }
      return destructuredLocalizationTargets(
        element.name,
        [...path, String(index)],
        element.initializer ?? defaultExpression
      )
    })
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return destructuredLocalizationTargets(
          property.name,
          [...path, property.name.text],
          property.objectAssignmentInitializer ?? defaultExpression
        )
      }
      if (!ts.isPropertyAssignment(property)) {
        return []
      }
      const propertyName = propertyNameText(property.name)
      return propertyName
        ? destructuredLocalizationTargets(
            property.initializer,
            [...path, propertyName],
            defaultExpression
          )
        : []
    })
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
        return []
      }
      const expression = unwrapExpression(element)
      return ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ? destructuredLocalizationTargets(
            expression.left,
            [...path, String(index)],
            expression.right
          )
        : destructuredLocalizationTargets(expression, [...path, String(index)], defaultExpression)
    })
  }
  return []
}
