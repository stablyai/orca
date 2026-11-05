import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

// Exercise the unbuilt worker and its production dependencies in Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !extname(specifier)
      ) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: transformSync(readFileSync(new URL(url), 'utf8'), {
          loader: 'ts',
          format: 'esm',
          target: 'esnext',
          define: {
            __filename: JSON.stringify(fileURLToPath(url)),
            __dirname: JSON.stringify(dirname(fileURLToPath(url)))
          }
        }).code
      }
    }
    return nextLoad(url, context)
  }
})
