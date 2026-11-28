import { resolve } from 'node:path'
import { normalizePath, type Plugin } from 'vite'
import {
  REACT_COMPILER_OPTIONS,
  isReactCompilerEnabled,
  reactCompilerExcludePattern
} from './react-compiler.ts'

// Captures the path below the renderer root: a checkout directory named like fix-test-run must not read as a test marker.
const rendererSource = /\/src\/renderer\/src(\/.*\.tsx?)$/
// Only shipped code is compiled; tests, fixtures, mocks and harnesses run as written.
const testSupport =
  /\/__(?:mocks|fixtures|tests)__\/|\.(?:test|spec|bench)\.tsx?$|[.-]test-|[.-]fixtures?\.tsx?$/
const importsVitest = /\bfrom ['"]vitest['"]/
const runtimeFallback = normalizePath(
  resolve(import.meta.dirname, 'vitest-compiler-runtime-fallback.ts')
)

// Why: @vitejs/plugin-react skips the compiler for vitest's server consumer, so call it directly.
export function vitestReactCompiler(): Plugin[] {
  if (!isReactCompilerEnabled()) {
    return []
  }
  const excluded = reactCompilerExcludePattern()
  return [
    {
      name: 'vitest-react-compiler',
      enforce: 'pre',
      configureVitest({ defineCacheKeyGenerator }) {
        // Ratchet baselines move files in and out of compilation without touching their source.
        defineCacheKeyGenerator(({ id }) =>
          excluded.test(normalizePath(id.split('?')[0])) ? 'react-compiler:excluded' : ''
        )
      },
      async transform(source, id) {
        const filename = normalizePath(id.split('?')[0])
        const rendererPath = rendererSource.exec(filename)?.[1]
        if (
          !rendererPath ||
          testSupport.test(rendererPath) ||
          excluded.test(filename) ||
          importsVitest.test(source)
        ) {
          return null
        }
        const { transform } = await import('oxc-transform-react')
        const result = await transform(filename, source, {
          jsx: { runtime: 'automatic', development: true },
          reactCompiler: REACT_COMPILER_OPTIONS,
          sourcemap: true
        })
        const diagnostics = result.errors.map(
          (e) => `${e.message}${e.codeframe ? `\n${e.codeframe}` : ''}`
        )
        if (result.fatal) {
          this.error(diagnostics.join('\n\n') || `React Compiler transform failed: ${filename}`)
        }
        return {
          code: result.code.replace(
            /from ["']react\/compiler-runtime["']/,
            `from ${JSON.stringify(runtimeFallback)}`
          ),
          map: result.map
        }
      }
    }
  ]
}
