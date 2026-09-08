import { existsSync } from 'node:fs'
import nodeModule from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Lets a build script import project TypeScript that uses bundler-style extensionless specifiers.
 * Node resolves ESM by exact path, so register this before the dynamic import that needs it.
 */
export function registerTypeScriptExtensionlessResolver() {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
        const candidate = new URL(`${specifier}.ts`, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    }
  })
}
