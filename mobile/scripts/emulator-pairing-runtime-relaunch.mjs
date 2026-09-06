import process from 'node:process'
import { startHeadlessPairingRuntime } from './start-emulator-pairing-runtime.mjs'

const SINGLE_INSTANCE_LOCK_FAILURE =
  'Another Orca instance is already running for this userData profile'
const MAX_RELAUNCH_ATTEMPTS = 20
const RELAUNCH_RETRY_DELAY_MS = 250

export async function restartHeadlessPairingRuntime(
  runtime,
  options,
  startRuntime = startHeadlessPairingRuntime,
  wait = delay
) {
  const port = runtime.port
  await runtime.stop()
  const holdMs = boundedRestartHoldMs(
    options.restartHoldMs ?? Number(process.env.ORCA_E2E_MOBILE_RESTART_HOLD_MS ?? 0)
  )
  if (holdMs > 0) {
    await wait(holdMs)
  }
  for (let attempt = 1; attempt <= MAX_RELAUNCH_ATTEMPTS; attempt += 1) {
    try {
      return await startRuntime({ ...options, port })
    } catch (error) {
      if (!isTransientSingleInstanceLock(error) || attempt === MAX_RELAUNCH_ATTEMPTS) {
        throw error
      }
      await wait(RELAUNCH_RETRY_DELAY_MS)
    }
  }
  throw new Error('Temporary desktop runtime relaunch attempts were exhausted')
}

function boundedRestartHoldMs(value) {
  return Number.isInteger(value) && value > 0 && value <= 10_000 ? value : 0
}

function isTransientSingleInstanceLock(error) {
  return error instanceof Error && error.message.includes(SINGLE_INSTANCE_LOCK_FAILURE)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
