import { createE2EConfig } from '../shared/e2e-config'

const preloadEnv = (
  import.meta as ImportMeta & {
    env?: { MODE?: string; VITE_EXPOSE_STORE?: boolean | string }
  }
).env

function isEnvFlagEnabled(value: boolean | string | undefined): boolean {
  return value === true || value === 'true'
}

// --mode e2e must also expose the store for manual SKIP_BUILD=1 rebuilds.
const exposeStore = preloadEnv?.MODE === 'e2e' || isEnvFlagEnabled(preloadEnv?.VITE_EXPOSE_STORE)

export const preloadE2EConfig = createE2EConfig({
  headless: process.env.ORCA_E2E_HEADLESS === '1',
  exposeStore,
  userDataDir: process.env.ORCA_E2E_USER_DATA_DIR ?? null,
  terminalParkingDelayMs: Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || null,
  terminalRetentionLimit: Number(process.env.ORCA_E2E_TERMINAL_RETENTION_LIMIT) || null
})
