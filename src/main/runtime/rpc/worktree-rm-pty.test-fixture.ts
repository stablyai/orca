import { vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../../providers/pty-provider-contract'

/** Only the provider's external effects are controlled; runtime teardown selects the sessions. */
export function removalPtyProvider(initial: PtyProcessInfo[]) {
  let processes = initial
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected PTY effect')
  }
  const shutdown = vi.fn<IPtyProvider['shutdown']>(async (id) => {
    processes = processes.filter((entry) => entry.id !== id)
  })
  const provider: IPtyProvider = {
    spawn: unused,
    attach: unused,
    write: () => {},
    writeWithSettlement: unused,
    resize: () => {},
    shutdown,
    sendSignal: unused,
    getCwd: unused,
    getInitialCwd: unused,
    clearBuffer: unused,
    resetInputModes: unused,
    acknowledgeDataEvent: () => {},
    hasChildProcesses: async () => false,
    getForegroundProcess: async () => null,
    serialize: unused,
    revive: unused,
    listProcesses: async () => processes,
    getDefaultShell: unused,
    getProfiles: unused,
    onData: () => () => {},
    onReplay: () => () => {},
    onExit: () => () => {}
  }
  return { provider, shutdown }
}
