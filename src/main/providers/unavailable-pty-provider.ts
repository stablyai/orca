import { writeRefused } from '../../shared/pty-write-settlement'
import type { IPtyProvider } from './types'

export function terminalServiceUnavailable(): Error {
  return new Error(
    'Terminal service unavailable. Retry starting the terminal service; existing terminals have not been stopped.'
  )
}

const unavailable = async (): Promise<never> => {
  throw terminalServiceUnavailable()
}
const unsubscribe = (): (() => void) => () => {}

/** Startup must never silently move terminal ownership into Electron. */
export function createUnavailablePtyProvider(): IPtyProvider {
  return {
    spawn: unavailable,
    attach: unavailable,
    probePtyLiveness: async () => null,
    write: () => false,
    writeWithSettlement: () => writeRefused('provider_unavailable'),
    resize: () => {},
    shutdown: unavailable,
    sendSignal: unavailable,
    getCwd: unavailable,
    getInitialCwd: unavailable,
    clearBuffer: unavailable,
    acknowledgeDataEvent: () => {},
    hasChildProcesses: async () => true,
    getForegroundProcess: async () => null,
    serialize: unavailable,
    revive: unavailable,
    listProcesses: unavailable,
    getDefaultShell: unavailable,
    getProfiles: unavailable,
    onData: unsubscribe,
    onReplay: unsubscribe,
    onExit: unsubscribe
  }
}
