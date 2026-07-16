import { createE2EConfig } from '../shared/e2e-config'

const preloadEnv = (
  import.meta as ImportMeta & {
    env?: { MODE?: string; VITE_EXPOSE_STORE?: boolean | string }
  }
).env

function isEnvFlagEnabled(value: boolean | string | undefined): boolean {
  return value === true || value === 'true'
}

// Why: `--mode e2e` must be enough for manual rebuilds used with SKIP_BUILD=1;
// keeping this out of a root .env file makes the test-only toggle less visible.
const exposeStore = preloadEnv?.MODE === 'e2e' || isEnvFlagEnabled(preloadEnv?.VITE_EXPOSE_STORE)

// Why: preload is the renderer's audited bridge into Electron startup state.
// Renderer code should consume a typed config object from this bridge instead
// of reading test-only env vars directly.
export const preloadE2EConfig = createE2EConfig({
  headless: process.env.ORCA_E2E_HEADLESS === '1',
  exposeStore,
  userDataDir: process.env.ORCA_E2E_USER_DATA_DIR ?? null,
  // Why: Number('') is 0 and Number(undefined) is NaN; both coerce to null so
  // only a real positive override reaches the renderer parking policy.
  terminalParkingDelayMs: Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || null
})
