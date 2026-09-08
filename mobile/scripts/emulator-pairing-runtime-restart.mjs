import process from 'node:process'
import { restartHeadlessPairingRuntime } from './emulator-pairing-runtime-relaunch.mjs'

export function installEmulatorPairingRuntimeRestart(
  runtimeState,
  options,
  { logStep, logSuccess, logError },
  signalTarget = process,
  restartRuntime = restartHeadlessPairingRuntime
) {
  let restartInFlight = null
  const restart = () => {
    const runtime = runtimeState.current
    if (!runtime || restartInFlight) {
      return
    }
    logStep('5', 'Restarting temporary desktop runtime on the paired endpoint...')
    restartInFlight = restartRuntime(runtime, options)
      .then((nextRuntime) => {
        runtimeState.current = nextRuntime
        logSuccess('Temporary desktop runtime restarted')
      })
      .catch((error) => {
        logError(`Failed to restart temporary desktop runtime: ${error.message}`)
      })
      .finally(() => {
        restartInFlight = null
      })
  }
  signalTarget.on('SIGUSR2', restart)
  return () => signalTarget.off('SIGUSR2', restart)
}
