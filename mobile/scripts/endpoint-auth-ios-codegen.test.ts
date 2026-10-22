import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

const requireNative = createRequire(import.meta.resolve('react-native/package.json'))
const nativeRoot = dirname(requireNative.resolve('./package.json'))

function socketCxxSpec(source: string): string {
  const start = source.indexOf(
    'template <typename T>\nclass JSI_EXPORT NativeWebSocketModuleCxxSpec'
  )
  const end = source.indexOf('\n};', start)
  if (start === -1 || end === -1) {
    throw new Error('Generated socket C++ interface unavailable')
  }
  return source.slice(start, end + 4)
}

it('ships iOS native interfaces generated from the patched socket schema', () => {
  const combine: unknown = requireNative(
    '@react-native/codegen/lib/cli/combine/combine-js-to-schema.js'
  )
  const generator: unknown = requireNative('./scripts/codegen/generate-specs-cli-executor.js')
  if (
    !combine ||
    typeof combine !== 'object' ||
    !('combineSchemasInFileList' in combine) ||
    typeof combine.combineSchemasInFileList !== 'function' ||
    !generator ||
    typeof generator !== 'object' ||
    !('generateSpecFromInMemorySchema' in generator) ||
    typeof generator.generateSpecFromInMemorySchema !== 'function'
  ) {
    throw new Error('Installed native code generator unavailable')
  }
  const directory = mkdtempSync(join(tmpdir(), 'orca-ios-socket-codegen-'))
  try {
    const schema = combine.combineSchemasInFileList(
      [join(nativeRoot, 'src')],
      'ios',
      /NativeSampleTurboModule/,
      'FBReactNativeSpec'
    )
    generator.generateSpecFromInMemorySchema(
      'ios',
      schema,
      directory,
      'FBReactNativeSpec',
      'com.facebook.fbreact.specs',
      'all'
    )
    const bundled = join(nativeRoot, 'React', 'FBReactNativeSpec')
    for (const file of ['FBReactNativeSpec.h', 'FBReactNativeSpec-generated.mm']) {
      expect(readFileSync(join(bundled, 'FBReactNativeSpec', file), 'utf8')).toBe(
        readFileSync(join(directory, 'FBReactNativeSpec', file), 'utf8')
      )
    }
    // Core's bundled C++ header also includes non-iOS test modules.
    expect(socketCxxSpec(readFileSync(join(bundled, 'FBReactNativeSpecJSI.h'), 'utf8'))).toBe(
      socketCxxSpec(readFileSync(join(directory, 'FBReactNativeSpecJSI.h'), 'utf8'))
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
