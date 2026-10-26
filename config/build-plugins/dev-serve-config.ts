import type { UserConfig } from 'electron-vite'
import { createDevRolldownRuntimeEnvPlugin } from './dev-rolldown-runtime-env'
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
      renderer: config.renderer && {
        ...config.renderer,
        ...(Number.isInteger(rendererPort)
          ? { server: { ...config.renderer.server, port: rendererPort, strictPort: true } }
          : {}),
        plugins: [...(config.renderer.plugins ?? []), createDevRolldownRuntimeEnvPlugin()]
      },
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
