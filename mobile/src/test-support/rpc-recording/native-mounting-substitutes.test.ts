import { describe, expect, it } from 'vitest'
import { nativeMountingSubstitutes } from './native-mounting-substitutes'

/** TypeScript's emitted interop helper, verbatim: what every `import X from` in a mounted module runs. */
function importDefault(module: unknown): { default: unknown } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mirrors the emit, which reads the marker off an untyped module record.
  const record = module as { __esModule?: unknown; default?: unknown }
  return record?.__esModule ? record : { default: module }
}

function substitute(name: string): unknown {
  const found = nativeMountingSubstitutes().get(name)
  if (found === undefined) {
    throw new Error(`no substitute for ${name}`)
  }
  return found
}

describe('nativeMountingSubstitutes', () => {
  it('names the module and member a recording reached instead of failing on a missing function', () => {
    const store = importDefault(substitute('@react-native-async-storage/async-storage')).default
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the member is a function by construction; the test asserts what calling it throws.
    const getItem = (store as { getItem: () => unknown }).getItem
    expect(typeof getItem).toBe('function')
    expect(() => getItem()).toThrow(
      'Native store reached during recording: @react-native-async-storage/async-storage.getItem'
    )
  })

  it('leaves the interop marker undefined so a default import binds the module, not the trap', () => {
    for (const name of ['@react-native-async-storage/async-storage', 'expo-crypto']) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the marker the emit reads, off a proxy with no declared shape.
      expect((substitute(name) as { __esModule?: unknown }).__esModule).toBeUndefined()
    }
  })

  it('throws on a member nobody substituted rather than recording an undefined native API', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read itself is the assertion; the proxy has no declared shape.
    expect(() => (substitute('expo-crypto') as { digest?: unknown }).digest).toThrow(
      'Unsubstituted native member: expo-crypto.digest'
    )
  })
})
