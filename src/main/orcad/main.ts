import '../memory/host-malloc-tunables-claim'
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
import { ORCAD_RECLAIM_STALE_LOCK_FLAG } from '../../shared/orcad-stale-lock-reclaim'

// A resolved plain-Node module graph proves the build guard; skip probes, ports and data-root locks.
if (process.argv.includes('--orcad-smoke-load-check')) {
  process.exit(0)
}

function failStartup(error: unknown): void {
  console.error('orcad: failed to start:', error)
  // Distinguish configuration refusals so supervisors cannot restart-spin on them.
  process.exit(resolveOrcadExitCode(error))
}

// One-shot launch and stop commands must skip server startup and preflights.
if (process.argv[2] === '--orcad-structured-provider-load-check') {
  void import('./orcad-structured-provider-smoke')
    .then(({ smokeLoadOrcadStructuredProviders }) => smokeLoadOrcadStructuredProviders())
    .then(() => process.exit(0))
    .catch(failStartup)
} else if (process.argv[2] === WINDOWS_BREAKAWAY_LAUNCH_FLAG) {
  runWindowsBreakawayLaunchIfRequested(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, process.argv)
} else if (
  process.argv[2] === ORCAD_COMPLETE_MANAGED_STOP_FLAG ||
  process.argv[2] === ORCAD_CANCEL_MANAGED_STOP_FLAG
) {
  void import('./orcad-managed-stop-command').then(({ runOrcadManagedStopCommandAndExit }) =>
    runOrcadManagedStopCommandAndExit(process.argv.slice(2))
  )
} else if (process.argv[2] === ORCAD_RECLAIM_STALE_LOCK_FLAG) {
  void import('./orcad-stale-lock-reclaim').then(({ runOrcadStaleLockReclaimCommandAndExit }) =>
    runOrcadStaleLockReclaimCommandAndExit(process.argv.slice(2))
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
        // The owner reads EOF; lingering native handles must not keep this probe alive.
        .then(() => process.stdout.write('', () => process.exit(0)))
        .catch(failStartup)
    } else {
      // Stdout is the readiness API; send incidental diagnostics to stderr.
      reserveServeStdoutForReadiness()
      void preflightBundledOrcadStartup()
        .then(() => {
          // Probe before deferred node-pty loading can crash this process.
          runOrcadNativePreflight()
          return main()
        })
        .catch(failStartup)
    }
  } catch (error) {
    failStartup(error)
  }
}
