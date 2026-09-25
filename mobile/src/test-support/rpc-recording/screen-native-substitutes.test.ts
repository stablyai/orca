import { createElement, type ElementType } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { inertIconModule } from './inert-native-elements'
import { nativeMountingSubstitutes } from './native-mounting-substitutes'
import { reactNativeScreenMembers, screenNativeSubstitutes } from './screen-native-substitutes'

function member(module: string, name: string): unknown {
  const substitute = nativeMountingSubstitutes().get(module)
  if (substitute === undefined) {
    throw new Error(`no substitute for ${module}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read is the assertion; a substitute proxy has no declared shape.
  return (substitute as Record<string, unknown>)[name]
}

/** Every element a screen can render through the table, by the module it is imported from. */
const INERT_ELEMENTS: readonly (readonly [string, string])[] = [
  ...Object.entries(reactNativeScreenMembers())
    .filter(([, value]) => typeof value === 'function')
    .map(([name]): readonly [string, string] => ['react-native', name]),
  ['react-native-safe-area-context', 'SafeAreaView']
]

describe('the inert screen substitutes', () => {
  /**
   * The whole contract in one place: an inert element renders its children and keeps its props
   * where a projection can read them, and does nothing else — the callbacks it is handed are never
   * invoked, including a render callback passed as its children.
   */
  it.each(INERT_ELEMENTS)('renders %s.%s inertly', (module, name) => {
    let invoked = 0
    const element = member(module, name)
    let rendered: ReturnType<typeof create> | undefined
    act(() => {
      rendered = create(
        createElement(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every entry above is an inert element component by construction.
          element as ElementType,
          { testID: name, onPress: () => invoked++, renderItem: () => invoked++ },
          'child'
        )
      )
    })
    const tree = rendered?.toJSON()
    expect(invoked).toBe(0)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a rendered host node carries exactly these fields.
    const node = tree as { type: string; props: Record<string, unknown>; children: unknown }
    expect(node.props.testID).toBe(name)
    expect(typeof node.props.onPress).toBe('function')
    expect(node.children).toEqual(['child'])
  })

  it('drops a render callback passed as children rather than calling it', () => {
    let invoked = 0
    let rendered: ReturnType<typeof create> | undefined
    act(() => {
      rendered = create(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the substitute is an inert element component by construction.
        createElement(member('react-native', 'Pressable') as ElementType, {}, () => {
          invoked++
          return null
        })
      )
    })
    expect(invoked).toBe(0)
    const tree = rendered?.toJSON()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a rendered host node carries exactly these fields.
    expect((tree as { children: unknown }).children).toBeNull()
  })

  it('pins the device inputs a screen reads instead of measuring them', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the member is a hook by construction.
    expect((member('react-native', 'useWindowDimensions') as () => unknown)()).toEqual({
      width: 390,
      height: 844
    })
    expect(member('react-native', 'StyleSheet')).toMatchObject({ hairlineWidth: 1 })
  })

  it('keeps a style sheet readable so a screen that reads one style sees it', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the member is the substituted StyleSheet by construction.
    const sheet = member('react-native', 'StyleSheet') as {
      create: (value: unknown) => unknown
      flatten: (value: unknown) => unknown
    }
    expect(sheet.create({ row: { flex: 1 } })).toEqual({ row: { flex: 1 } })
    expect(sheet.flatten([{ flex: 1 }, [{ gap: 2 }]])).toEqual({ flex: 1, gap: 2 })
  })

  it('answers any icon name with its own element, because every export here is an icon', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the icon module answers every string key.
    const icons = inertIconModule() as Record<string, ElementType>
    expect(icons.ChevronLeft).toBe(icons.ChevronLeft)
    act(() => {
      create(createElement(icons.ChevronLeft!, { size: 20 }))
    })
  })

  it('throws on a member nobody listed, in every screen package', () => {
    for (const [module, substitute] of screenNativeSubstitutes()) {
      if (module === 'lucide-react-native') {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read is the assertion; a substitute proxy has no declared shape.
      expect(() => (substitute as Record<string, unknown>).notASubstitutedMember).toThrow(
        `Unsubstituted native member: ${module}.notASubstitutedMember`
      )
    }
  })
})
