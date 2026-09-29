/** Executable entry for `orcad`. See `./orcad-entry.ts`. */
import process from 'node:process'
import { main, resolveOrcadExitCode } from './orcad-entry'
import { runOrcadNativePreflight } from './orcad-native-preflight'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/orcad-profile-preflight'
import { preflightBundledOrcadStartup, runOrcadProfilePreflight } from './orcad-profile-preflight'
import { handoffToBundledOrcad } from './orcad-bundled-runtime'

// Why exit before the preflight: reaching this line means the whole module graph resolved
// under plain Node, which is all the build guard needs to prove. Probing natives or
// starting a server to prove it would bind a port and take a data-root lock on a build
// machine.
if (process.argv.includes('--orcad-smoke-load-check')) {
  process.exit(0)
}

// Why here and not inside startOrcad: this must run before anything requires node-pty,
// and `orcad-entry` reaches it through `await import('../ipc/pty')`. Static imports are
// evaluated before this statement, so the guarantee is that no module in the graph
// requires node-pty at import time — which the bundle's lazy `require("node-pty")` in
// local-pty-provider satisfies. See ./node-pty-precondition.ts for why a child process.
function failStartup(error: unknown): void {
  console.error('orcad: failed to start:', error)
  // Why a resolved code and not a bare 1: a data-root or bind-address refusal is a
  // configuration fault that restarting cannot fix, and a supervisor needs to tell the two
  // apart to avoid restart-spinning on it.
  process.exit(resolveOrcadExitCode(error))
}

try {
  if (!handoffToBundledOrcad()) {
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
        .then(() => {
          runOrcadNativePreflight()
          return main()
        })
        .catch(failStartup)
    }
  }
} catch (error) {
  failStartup(error)
}
