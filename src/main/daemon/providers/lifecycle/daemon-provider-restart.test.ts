import { describe, expect, it, vi } from 'vitest'
import {
  describeTerminalExitCause,
  resolveUnreportedExitCause,
  type TerminalExitCause
} from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'

const exits: { code: number; cause?: TerminalExitCause }[] = []
const adapter = {
  getActiveSessionIds: () => ['session-1'],
  fanoutSyntheticExits: (code: number, exit: { cause?: TerminalExitCause }) =>
    exits.push({ code, ...exit })
}

vi.mock('./daemon-provider-state', () => ({
  getDaemonSpawner: () => ({ resetRespawnWindow: () => {} }),
  getDaemonProvider: () => adapter,
  replaceDaemonProvider: () => {}
}))
vi.mock('../../launch/daemon-launch-paths', () => ({
  getDaemonRuntimeDir: () => '/runtime',
  getDaemonHistoryDir: () => '/history'
}))
vi.mock('../../executable-host/macos/macos-retired-daemon-recovery', () => ({
  recoverRetiredMacDaemonJobs: async () => {}
}))
vi.mock('../../../ipc/pty/provider/listener-lifecycle', () => ({
  unbindLocalProviderListeners: () => {},
  rebindLocalProviderListeners: () => {}
}))
// Stop the restart once its sessions have been ended.
vi.mock('../../launch/daemon-protocol-cleanup', () => ({
  cleanupDaemonForProtocol: async () => {
    throw new Error('stop after fan-out')
  }
}))

describe('daemon restart', () => {
  it('ends its sessions as host loss, not as a stop that was never confirmed', async () => {
    const { restartDaemon } = await import('./daemon-provider-restart')
    await expect(restartDaemon()).rejects.toThrow('stop after fan-out')
    expect(exits).toHaveLength(1)
    // As the runtime reads it: a missing cause falls back to the bare code.
    const [exit] = exits
    expect(describeTerminalExitCause(exit.cause ?? resolveUnreportedExitCause(exit.code))).toBe(
      'Agent process lost; its terminal host or session is gone'
    )
  })
})
