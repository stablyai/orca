/** Executable entry for `orcad`. See `./orcad-entry.ts`. */
import process from 'node:process'
import { main } from './orcad-entry'
import { resolveOrcadExitCode } from './orcad-exit-code'
import { reserveServeStdoutForReadiness } from '../server/serve-stdout-boundary'
import { runOrcadNativePreflight } from './orcad-native-preflight'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/orcad-profile-preflight'
import { preflightBundledOrcadStartup, runOrcadProfilePreflight } from './orcad-profile-preflight'
import { assertOrcadServerRuntime } from './orcad-bundled-runtime'
import {
  formatOrcadNativePreflightReport,
  ORCAD_NATIVE_PREFLIGHT_FLAG
} from '../../shared/orcad-native-preflight-report'
import {
  ORCAD_CANCEL_MANAGED_STOP_FLAG,
  ORCAD_COMPLETE_MANAGED_STOP_FLAG
} from '../../shared/orcad-stop-request'
import {
  ORCAD_WINDOWS_BREAKAWAY_CONTRACT,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG
} from '../../shared/windows-breakaway-launch'
import { runWindowsBreakawayLaunchIfRequested } from '../../shared/windows-breakaway-launcher'
import { parseArgs } from './orcad-command-arguments'

// Why exit before the preflight: reaching this line means the whole module graph resolved
// under plain Node, which is all the build guard needs to prove. Probing natives or
// starting a server to prove it would bind a port and take a data-root lock on a build
// machine.
if (process.argv.includes('--orcad-smoke-load-check')) {
  process.exit(0)
}

function failStartup(error: unknown): void {
  console.error('orcad: failed to start:', error)
  // Why a resolved code and not a bare 1: a data-root or bind-address refusal is a
  // configuration fault that restarting cannot fix, and a supervisor needs to tell the two
  // apart to avoid restart-spinning on it.
  process.exit(resolveOrcadExitCode(error))
}

// One-shot launch and stop commands must skip server startup and preflights.
if (process.argv[2] === WINDOWS_BREAKAWAY_LAUNCH_FLAG) {
  runWindowsBreakawayLaunchIfRequested(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, process.argv)
} else if (
  process.argv[2] === ORCAD_COMPLETE_MANAGED_STOP_FLAG ||
  process.argv[2] === ORCAD_CANCEL_MANAGED_STOP_FLAG
) {
  void import('./orcad-managed-stop-command').then(({ runOrcadManagedStopCommandAndExit }) =>
    runOrcadManagedStopCommandAndExit(process.argv.slice(2))
  )
} else {
  startOrcadProcess()
}

function startOrcadProcess(): void {
  try {
    const argv = process.argv.slice(2)
    if ((argv.includes('--help') || argv.includes('-h')) && parseArgs(argv).help) {
      void main(argv).catch(failStartup)
      return
    }
    assertOrcadServerRuntime()
    const flag = process.argv[2]
    if (flag === ORCAD_NATIVE_PREFLIGHT_FLAG && process.argv.length === 3) {
      void import('./node-pty-precondition').then(({ checkNodePtyPrecondition }) => {
        const verdict = checkNodePtyPrecondition()
        const report = formatOrcadNativePreflightReport(verdict.status, verdict.reason ?? null)
        process.stdout.write(`${report}\n`, () => process.exit(0))
      }, failStartup)
    } else if (
      (flag === ORCAD_PROFILE_PREFLIGHT_FLAG || flag === ORCAD_STARTUP_PREFLIGHT_FLAG) &&
      process.argv.length === 4
    ) {
      void runOrcadProfilePreflight(process.argv[3], {
        nativeFeatures: flag === ORCAD_PROFILE_PREFLIGHT_FLAG
      })
        // Why exit: the owner reads to EOF, so a lingering native handle must not hold the probe open.
        .then(() => process.stdout.write('', () => process.exit(0)))
        .catch(failStartup)
    } else {
      // Why: stdout is the serve readiness API; incidental diagnostics go to stderr.
      reserveServeStdoutForReadiness()
      void preflightBundledOrcadStartup()
        .then(() => {
          // Why: must run before anything requires node-pty; the bundle defers require("node-pty")
          // so no import does. See ./node-pty-precondition.ts.
          runOrcadNativePreflight()
          return main()
        })
        .catch(failStartup)
    }
  } catch (error) {
    failStartup(error)
  }
}
