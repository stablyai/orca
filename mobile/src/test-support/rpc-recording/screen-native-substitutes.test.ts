import { createElement, type ElementType } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { nativeMountingSubstitutes } from './native-mounting-substitutes'
import { reactNativeScreenMembers } from './screen-native-substitutes'

function member(module: string, name: string): unknown {
  const substitute = nativeMountingSubstitutes().get(module)
  if (substitute === undefined) {
    throw new Error(`no substitute for ${module}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read is the assertion; a substitute proxy has no declared shape.
  return (substitute as Record<string, unknown>)[name]
}

const INERT_ELEMENTS: readonly (readonly [string, string])[] = [
  ...Object.entries(reactNativeScreenMembers())
    .filter(([, value]) => typeof value === 'function')
    .map(([name]): readonly [string, string] => ['react-native', name]),
  ['react-native-safe-area-context', 'SafeAreaView']
]

describe('the inert screen substitutes', () => {
  // Preserve children/props while never invoking device callbacks, including render-callback children.
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
        createElement(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the substitute is an inert element component by construction.
          member('react-native', 'Pressable') as ElementType,
          {},
          // @ts-expect-error -- deliberately invalid function children; asserts the substitute drops them
          () => {
            invoked++
            return null
          }
        )
      )
    })
    expect(invoked).toBe(0)
    const tree = rendered?.toJSON()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a rendered host node carries exactly these fields.
    expect((tree as { children: unknown }).children).toBeNull()
  })
})
