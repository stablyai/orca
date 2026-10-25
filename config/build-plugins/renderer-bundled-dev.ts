import type { UserConfig } from 'electron-vite'

/**
 * Default in dev (opt out with `ORCA_DEV_BUNDLED=0`): Vite's bundled dev mode serves the renderer as
 * bundled chunks instead of thousands of per-module requests, which shortens dev startup and reloads.
 */
export function withBundledRendererDev(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env
): UserConfig {
  const renderer = config.renderer
  if (env.ORCA_DEV_BUNDLED === '0' || !renderer || typeof renderer === 'function') {
    return config
  }
  const rollupOptions = renderer.build?.rollupOptions
  const output = Array.isArray(rollupOptions?.output) ? undefined : rollupOptions?.output
  return {
    ...config,
    renderer: {
      ...renderer,
      experimental: { ...renderer.experimental, bundledDev: true },
      build: {
        ...renderer.build,
        rollupOptions: {
          ...rollupOptions,
          // Why: chunks shared by the four HTML entries otherwise run before the React Refresh
          // preamble in the entry chunk, and the renderer fails with "can't detect preamble".
          output: { ...output, strictExecutionOrder: true }
        }
      }
    }
  }
}
