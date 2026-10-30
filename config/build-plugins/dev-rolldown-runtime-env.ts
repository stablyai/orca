import type { Plugin } from 'vite'
import { removeDevRolldownRuntimeEnv } from '../scripts/dev-rolldown-runtime-env.mjs'

/** electron-vite starts Electron after the renderer server, so this runs once Rolldown has sized its pools. */
export function createDevRolldownRuntimeEnvPlugin(): Plugin {
  return {
    name: 'orca-dev-rolldown-runtime-env',
    apply: 'serve',
    config() {
      removeDevRolldownRuntimeEnv(process.env)
    }
  }
}
