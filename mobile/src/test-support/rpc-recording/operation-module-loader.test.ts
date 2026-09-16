import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterAll, describe, expect, it } from 'vitest'
import { operationModuleLoader } from './operation-module-loader'

/**
 * A tree of source files instead of a product path, so these two properties are pinned by what the
 * loader does rather than by what one screen happens to import today.
 */
const roots: string[] = []
function loaderOver(files: Record<string, string>): ReturnType<typeof operationModuleLoader> {
  const root = mkdtempSync(join(tmpdir(), 'rpc-loader-'))
  roots.push(root)
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, 'mobile/src'), { recursive: true })
    writeFileSync(join(root, 'mobile/src', name), source)
  }
  return operationModuleLoader(root)
}

afterAll(() => {
  roots.length = 0
})

describe('the mounted module loader', () => {
  /**
   * Product sources compile with the automatic runtime and never import React, so a classic
   * `React.createElement` emit throws `React is not defined` on the first render of every screen.
   */
  it('compiles JSX against the automatic runtime and the React the test renderer drives', () => {
    const modules = loaderOver({
      'screen.tsx': `
        import { View } from 'react-native'
        export function Screen(props: { label: string }) {
          return <View accessibilityLabel={props.label}>{props.label}</View>
        }
      `
    })
    const { Screen } = modules.load<{ Screen: (props: { label: string }) => unknown }>(
      'mobile/src/screen.tsx'
    )
    let rendered: ReturnType<typeof create> | undefined
    act(() => {
      rendered = create(createElement(Screen, { label: 'files' }))
    })
    expect(rendered?.toJSON()).toEqual({
      type: 'View',
      props: { accessibilityLabel: 'files' },
      children: ['files']
    })
  })

  /**
   * Both interop helpers short-circuit on `__esModule`, so the trap binds as the module itself in
   * all three import forms: the module loads, and the refusal lands on the member a recording
   * actually wanted rather than on every module that merely mentions the package.
   */
  it('lets a default import of an unlisted package load, and refuses the member it uses', () => {
    const modules = loaderOver({
      'uses-default.ts': `
        import Animated from 'react-native-not-substituted'
        export const read = () => Animated.createAnimatedComponent
      `
    })
    const { read } = modules.load<{ read: () => unknown }>('mobile/src/uses-default.ts')
    expect(typeof read).toBe('function')
    expect(() => read()).toThrow(
      'Unspecified native mounting dependency: react-native-not-substituted.default'
    )
  })

  it('refuses a named import of an unlisted package on the read', () => {
    const modules = loaderOver({
      'uses-named.ts': `
        import { thing } from 'expo-not-substituted'
        export const read = () => thing
      `
    })
    const { read } = modules.load<{ read: () => unknown }>('mobile/src/uses-named.ts')
    expect(() => read()).toThrow(
      'Unspecified native mounting dependency: expo-not-substituted.thing'
    )
  })

  /**
   * What lets a screen mount a module such as `platform/haptics.ts`, which imports a device package
   * it only touches on a press: loading the importer is not itself a use.
   */
  it('lets a namespace import of an unlisted package load, and refuses the member it reads', () => {
    const modules = loaderOver({
      'uses-namespace.ts': `
        import * as Haptics from 'expo-not-substituted'
        export const read = () => Haptics.selectionAsync
      `
    })
    const { read } = modules.load<{ read: () => unknown }>('mobile/src/uses-namespace.ts')
    expect(typeof read).toBe('function')
    expect(() => read()).toThrow(
      'Unspecified native mounting dependency: expo-not-substituted.selectionAsync'
    )
  })
})
