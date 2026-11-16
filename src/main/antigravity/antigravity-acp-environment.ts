import { ANTIGRAVITY_BROWSER_COMMAND } from './antigravity-browser-helper'
export { scrubAntigravityAcpEnvironment } from './antigravity-acp-environment-sanitizer'

// Isolate sign-in files, capture browser links and flush Python output after scrubbing inherited auth.
export const ANTIGRAVITY_ACP_ENV = {
  AGY_ACP_FORCE_FILE_STORAGE: '1',
  BROWSER: ANTIGRAVITY_BROWSER_COMMAND,
  PYTHONUNBUFFERED: '1',
  ELECTRON_RUN_AS_NODE: '1'
}
