import type { UserConfig } from 'electron-vite'
import { withBundledRendererDev } from './renderer-bundled-dev'

/** Development-server overrides; Electron Vite also uses Vite's build command for the dev main process. */
export function createDevServeConfig(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env
): UserConfig {
  // run-electron-vite-dev.mjs probes a per-worktree port and reports it; strict keeps that report true.
  const rendererPort = Number.parseInt(env.ORCA_DEV_RENDERER_PORT ?? '', 10)
  return withBundledRendererDev(
    {
      ...config,
      renderer:
        Number.isInteger(rendererPort) && config.renderer
          ? {
              ...config.renderer,
              server: { ...config.renderer.server, port: rendererPort, strictPort: true }
            }
          : config.renderer,
      main: {
        ...config.main,
        build: {
          ...config.main?.build,
          minify: false,
          sourcemap: env.ORCA_DEV_MAIN_SOURCEMAPS === '0' ? false : config.main?.build?.sourcemap
        }
      }
    },
    env
  )
}
