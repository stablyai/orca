import { createE2EConfig, type E2EConfig } from '../shared/e2e-config'

export function getMainE2EConfig(): E2EConfig {
  return createE2EConfig({
    headless: process.env.ORCA_E2E_HEADLESS === '1',
    userDataDir: process.env.ORCA_E2E_USER_DATA_DIR ?? null
  })
}
