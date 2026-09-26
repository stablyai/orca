import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  PRESSABLE_TAGS,
  readAttribute,
  type Read
} from '../mobile-web-shell/pressable-control-source-reader'

/**
 * This header renders two toolbars and the phone sees the narrow one. Its controls carried no role
 * and no name, so a screen reader could not find them and C2.9's render check could only assert
 * their absence at 390 px. The wide toolbar already names every control, and the name is computed
 * from the same state, so the two must agree rather than each invent wording.
 *
 * A spread reads as unknown rather than absent: a control whose handler or whose accessibility
 * props arrive through one is a control this scan cannot judge, so it fails both rules and says so,
 * instead of passing quietly or reading as an unnamed control.
 */
const HEADER = 'src/host-screen/host-screen-header.tsx'
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')

/**
 * One entry per control both toolbars render, keyed by the handler it presses, which is what makes
 * two elements the same control. Each must be found twice, so the naming rule below always has
 * pairs to compare: the rule derives its own groups, and over a file with no repeated handler it
 * would hold vacuously.
 */
const SHARED_CONTROLS = [
  '() => state.setShowFilterModal(true)',
  '() => state.setShowSortPicker(true)',
  '() => state.setShowGroupPicker(true)',
  '() => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/accounts`)',
  '() => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/tasks`)',
  '() => state.setShowSearch((s) => !s)'
]

type Control = { line: number; press: Read; role: Read; label: Read }

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
      if (PRESSABLE_TAGS.has(element.tagName.getText())) {
        const press = readAttribute(element, 'onPress')
        // A Pressable with no handler is decoration; one whose handler is spread in is a control.
        if (!press.known || press.value !== '') {
          found.push({
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            press,
            role: readAttribute(element, 'accessibilityRole'),
            label: readAttribute(element, 'accessibilityLabel')
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function show(read: Read): string {
  if (!read.known) {
    return 'spread'
  }
  return read.value || 'none'
}

function describeControl(control: Control): string {
  return `${HEADER}:${control.line} press=${show(control.press)} role=${show(control.role)} label=${show(
    control.label
  )}`
}

const CONTROLS = headerControls()

/** Every handler this header presses more than once, with the names its sites give it. */
function namesByHandler(): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>()
  for (const control of CONTROLS) {
    if (!control.press.known) {
      continue
    }
    const names = groups.get(control.press.value) ?? new Set<string>()
    names.add(show(control.label))
    groups.set(control.press.value, names)
  }
  return groups
}

describe('host header controls carry a role and a name in both toolbars', () => {
  it('finds each shared control in both toolbars, so the naming rule has pairs to compare', () => {
    expect(
      SHARED_CONTROLS.filter(
        (press) =>
          CONTROLS.filter((control) => control.press.known && control.press.value === press)
            .length !== 2
      )
    ).toEqual([])
  })

  it('gives every pressable control the button role', () => {
    expect(
      CONTROLS.filter((control) => !control.role.known || control.role.value !== 'button').map(
        describeControl
      )
    ).toEqual([])
  })

  it('names every pressable control', () => {
    expect(
      CONTROLS.filter((control) => !control.label.known || control.label.value === '').map(
        describeControl
      )
    ).toEqual([])
  })

  it('names a control the same way wherever this header renders it', () => {
    const disagreeing = [...namesByHandler()]
      .filter(([, names]) => names.size > 1)
      .map(([press, names]) => `${press} -> ${[...names].sort().join(' | ')}`)
    expect(disagreeing).toEqual([])
  })
})
