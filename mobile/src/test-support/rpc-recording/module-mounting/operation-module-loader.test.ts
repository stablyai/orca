import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { operationModuleLoader } from './operation-module-loader'

// Use synthetic trees so loader properties do not depend on current product imports.
const roots: string[] = []
function sourceTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pr-31602-rpc-loader-'))
  roots.push(root)
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, 'mobile/src'), { recursive: true })
    writeFileSync(join(root, 'mobile/src', name), source)
  }
  return root
}
function loaderOver(files: Record<string, string>): ReturnType<typeof operationModuleLoader> {
  return operationModuleLoader(sourceTree(files))
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

describe('the mounted module loader', () => {
  it('follows named reexports reached through the task foundation barrel', () => {
    const modules = loaderOver({
      'mobile-tasks-legacy-foundation.tsx': `export * from './mapping'`,
      'mapping.ts': `export { run as search } from './operation'; export type { Missing } from './missing'`,
      'operation.ts': `export const run = (query: string) => 'is:pr ' + query`
    })
    const foundation = modules.load<{ search: (query: string) => string }>(
      'mobile/src/mobile-tasks-legacy-foundation.tsx'
    )
    expect(foundation.search('is:open')).toBe('is:pr is:open')
    expect(() => modules.load('mobile/src/mobile-tasks-legacy-foundation.tsx').Missing).toThrow(
      'Unmapped barrel export: Missing'
    )
  })

  // Preserve proxy interop so refusal occurs on actual member use rather than merely importing the package.
  it('lets a default import of an unlisted package load, and refuses the member it uses', () => {
    const modules = loaderOver({
      'uses-default.ts': `
        import Animated from 'react-native-not-substituted'
        export const read = () => Animated.createAnimatedComponent
      `
    })
    const { read } = modules.load<{ read: () => unknown }>('mobile/src/uses-default.ts')
    expect(() => read()).toThrow(
      'Unspecified native mounting dependency: react-native-not-substituted.default'
    )
  })

  // Default dependencies may reference native members before an adapter overrides them; import alone must remain possible.
  it('lets a namespace import of an unlisted package load, and refuses the member it reads', () => {
    const modules = loaderOver({
      'uses-namespace.ts': `
        import * as Haptics from 'expo-not-substituted'
        export const read = () => Haptics.selectionAsync
      `
    })
    const { read } = modules.load<{ read: () => unknown }>('mobile/src/uses-namespace.ts')
    expect(() => read()).toThrow(
      'Unspecified native mounting dependency: expo-not-substituted.selectionAsync'
    )
  })
})
