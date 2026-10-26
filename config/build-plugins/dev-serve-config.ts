import type { UserConfig } from 'electron-vite'
import { DEV_RUNTIME_ENV_KEYS } from '../scripts/dev-rolldown-runtime-env.mjs'
import { createDevRolldownRuntimeEnvPlugin } from './dev-rolldown-runtime-env'
import { withBundledRendererDev } from './renderer-bundled-dev'

/** Development-server overrides; Electron Vite also uses Vite's build command for the dev main process. */
export function createDevServeConfig(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env
): UserConfig {
  // run-electron-vite-dev.mjs probes a per-worktree port and reports it; strict keeps that report true.
  const rendererPort = Number.parseInt(env.ORCA_DEV_RENDERER_PORT ?? '', 10)
  const hasPort = Number.isInteger(rendererPort)
  // Only the dev wrapper sets runtime keys; without them there is nothing to strip.
  const stripsRuntimeEnv = Boolean(env[DEV_RUNTIME_ENV_KEYS])
  return withBundledRendererDev(
    {
      ...config,
      renderer:
        config.renderer && (hasPort || stripsRuntimeEnv)
          ? {
              ...config.renderer,
              ...(hasPort
                ? { server: { ...config.renderer.server, port: rendererPort, strictPort: true } }
                : {}),
              ...(stripsRuntimeEnv
                ? {
                    plugins: [
                      ...(config.renderer.plugins ?? []),
                      createDevRolldownRuntimeEnvPlugin()
                    ]
                  }
                : {})
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
