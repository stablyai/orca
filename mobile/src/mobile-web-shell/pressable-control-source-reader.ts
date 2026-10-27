import ts from 'typescript-api'

// Share source-reading rules across accessibility censuses so unnamed-control checks agree without rendering.
export const PRESSABLE_TAGS = new Set(['Pressable', 'TouchableOpacity'])

export type Read = { known: true; value: string } | { known: false }
const UNKNOWN: Read = { known: false }

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ').trim()
}

export function spreadsProps(element: ts.JsxOpeningLikeElement): boolean {
  return element.attributes.properties.some((property) => ts.isJsxSpreadAttribute(property))
}

// Treat shorthand, empty literals/templates and undefined alike as unnamed; source-text emptiness alone misses expression forms.
function readExpression(expression: ts.Expression): string {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text
  }
  if (ts.isIdentifier(expression) && expression.text === 'undefined') {
    return ''
  }
  return normalize(expression.getText())
}

export function readAttribute(element: ts.JsxOpeningLikeElement, name: string): Read {
  if (spreadsProps(element)) {
    return UNKNOWN
  }
  for (const property of element.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText() === name) {
      const initializer = property.initializer
      if (!initializer) {
        return { known: true, value: '' }
      }
      if (ts.isStringLiteral(initializer)) {
        return { known: true, value: initializer.text }
      }
      if (ts.isJsxExpression(initializer) && initializer.expression) {
        return { known: true, value: readExpression(initializer.expression) }
      }
      return { known: true, value: normalize(initializer.getText()) }
    }
  }
  return { known: true, value: '' }
}
