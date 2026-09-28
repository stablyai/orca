/** Bun application entry; the public launcher owns runtime selection. */
import process from 'node:process'
import { main, resolveOrcadExitCode } from './orcad-entry'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/orcad-profile-preflight'
import { preflightBundledOrcadStartup, runOrcadProfilePreflight } from './orcad-profile-preflight'

function failStartup(error: unknown): void {
  console.error('orcad: failed to start:', error)
  // Why a resolved code and not a bare 1: a data-root or bind-address refusal is a
  // configuration fault that restarting cannot fix, and a supervisor needs to tell the two
  // apart to avoid restart-spinning on it.
  process.exit(resolveOrcadExitCode(error))
}

try {
  if (!process.versions.bun) {
    throw new Error('orcad requires its bundled Bun runtime')
  }
  // Load-check evaluates the Bun application graph without opening profile state.
  if (process.argv.includes('--orcad-smoke-load-check')) {
    process.exit(0)
  }
  const flag = process.argv[2]
  if (
    (flag === ORCAD_PROFILE_PREFLIGHT_FLAG || flag === ORCAD_STARTUP_PREFLIGHT_FLAG) &&
    process.argv.length === 4
  ) {
    void runOrcadProfilePreflight(process.argv[3], {
      nativeFeatures: flag === ORCAD_PROFILE_PREFLIGHT_FLAG
    }).catch(failStartup)
  } else {
    void preflightBundledOrcadStartup()
      .then(() => main())
      .catch(failStartup)
  }
} catch (error) {
  failStartup(error)
}
