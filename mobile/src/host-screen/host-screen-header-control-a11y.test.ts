import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * This header renders two toolbars and the phone sees the narrow one. Its controls carried no role
 * and no name, so a screen reader could not find them and C2.9's render check could only assert
 * their absence at 390 px. The wide toolbar already names every control, and the name is computed
 * from the same state, so the two must agree rather than each invent wording.
 */
const HEADER = 'src/host-screen/host-screen-header.tsx'
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')

/**
 * One entry per control both toolbars render, keyed by the handler it presses, which is what makes
 * the two siblings the same control. Each must be found twice: a control dropped from one toolbar
 * would otherwise leave the naming rule below comparing a group of one against itself.
 */
const SHARED_CONTROLS = [
  '() => state.setShowFilterModal(true)',
  '() => state.setShowSortPicker(true)',
  '() => state.setShowGroupPicker(true)',
  '() => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/accounts`)',
  '() => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/tasks`)',
  '() => state.setShowSearch((s) => !s)'
]

type Control = { line: number; press: string; role: string; label: string }

/** Formatting differs between the branches, so compare what the expression says, not how it wraps. */
function normalize(source: string): string {
  return source.replace(/\s+/g, ' ').trim()
}

function attributeText(element: ts.JsxOpeningLikeElement, name: string): string {
  for (const property of element.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText() === name) {
      const initializer = property.initializer
      if (!initializer) {
        return ''
      }
      if (ts.isStringLiteral(initializer)) {
        return initializer.text
      }
      if (ts.isJsxExpression(initializer) && initializer.expression) {
        return normalize(initializer.expression.getText())
      }
      return normalize(initializer.getText())
    }
  }
  return ''
}

function headerControls(): Control[] {
  const source = ts.createSourceFile(
    HEADER,
    readFileSync(join(MOBILE_ROOT, HEADER), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const found: Control[] = []
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const element = ts.isJsxElement(node) ? node.openingElement : node
      if (element.tagName.getText() === 'Pressable') {
        const press = attributeText(element, 'onPress')
        if (press) {
          found.push({
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            press,
            role: attributeText(element, 'accessibilityRole'),
            label: attributeText(element, 'accessibilityLabel')
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function describeControl(control: Control): string {
  return `${HEADER}:${control.line} press=${control.press} role=${control.role || 'none'} label=${
    control.label || 'none'
  }`
}

const CONTROLS = headerControls()

describe('host header controls carry a role and a name in both toolbars', () => {
  it('finds each shared control in both toolbars, so the naming rule cannot compare one with itself', () => {
    expect(
      SHARED_CONTROLS.filter(
        (press) => CONTROLS.filter((control) => control.press === press).length !== 2
      )
    ).toEqual([])
  })

  it('gives every pressable control the button role', () => {
    expect(CONTROLS.filter((control) => control.role !== 'button').map(describeControl)).toEqual([])
  })

  it('names every pressable control', () => {
    expect(CONTROLS.filter((control) => control.label === '').map(describeControl)).toEqual([])
  })

  it('names a shared control the same way in both toolbars', () => {
    const disagreeing = SHARED_CONTROLS.filter((press) => {
      const labels = new Set(
        CONTROLS.filter((control) => control.press === press).map((control) => control.label)
      )
      return labels.size > 1
    })
    expect(disagreeing).toEqual([])
  })
})
