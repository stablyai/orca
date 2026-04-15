import { createE2EConfig } from '../shared/e2e-config'

const preloadEnv = (
  import.meta as ImportMeta & {
    env?: { VITE_EXPOSE_STORE?: boolean }
  }
).env

// Why: preload is the renderer's audited bridge into Electron startup state.
// Renderer code should consume a typed config object from this bridge instead
// of reading test-only env vars directly.
export const preloadE2EConfig = createE2EConfig({
  headless: process.env.ORCA_E2E_HEADLESS === '1',
  exposeStore: preloadEnv?.VITE_EXPOSE_STORE,
  userDataDir: process.env.ORCA_E2E_USER_DATA_DIR ?? null
})
