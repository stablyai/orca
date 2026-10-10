import type { RequireContext } from 'expo-router/build/types'

/**
 * Replaced wholesale at build time by config/scripts/build-mobile-web-app-bundle.mjs, which
 * generates the static imports esbuild needs in place of Metro's require.context. This body is
 * what typechecking and Metro see; it never runs, because only the web build resolves this file.
 */
const routeContext: RequireContext = Object.assign(
  (id: string): never => {
    throw new Error(`[orca-mobile-web-app] route manifest was not generated: ${id}`)
  },
  {
    keys: (): string[] => [],
    resolve: (id: string): string => {
      throw new Error(`[orca-mobile-web-app] route manifest was not generated: ${id}`)
    },
    id: 'orca-mobile-web-app-routes'
  }
)

export default routeContext
