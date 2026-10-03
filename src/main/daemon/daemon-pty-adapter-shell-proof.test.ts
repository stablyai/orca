import { describe, expect, it, vi } from 'vitest'
import type * as AgentForegroundProcess from '../providers/agent-foreground-process'
import { DaemonPtyAdapter } from './daemon-pty-adapter'

// Daemons survive app updates. Those from v27 until the shell-confirm request existed answer it as
// unknown, yet still send fenced foreground evidence, which must decide; a dead socket must not.

// This host's own process-table read of the pane: its shell in front.
vi.mock('../providers/agent-foreground-process', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentForegroundProcess>()),
  confirmPaneShellForegroundProcess: async () => true
}))

type ClientInternals = {
  client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
}

const SHELL_IN_FRONT = {
  foregroundProcess: null,
  hasChildProcesses: false,
  foregroundProcessEvidence: {
    authorityGeneration: 'daemon-generation',
    observationEpoch: 1,
    capturedAgeMs: 0,
    ptyId: 'sess-a',
    ptyIncarnationId: 'inc-1',
    verdict: 'live',
    processName: null,
    fence: {
      platform: 'posix',
      shellPid: 100,
      shellStartTime: 'shell-birth',
      tty: '/dev/pts/3',
      foregroundPgid: 100
    }
  }
}

function createAdapter(protocolVersion: number, request: ReturnType<typeof vi.fn>) {
  const adapter = new DaemonPtyAdapter({
    socketPath: '/tmp/orca-shell-proof.sock',
    tokenPath: '/tmp/orca-shell-proof.token',
    protocolVersion
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's private client is replaced with a request stub, as the steady-state compat spec does.
  ;(adapter as unknown as ClientInternals).client = { request, disconnect: vi.fn() }
  return adapter
}

describe.skipIf(process.platform === 'win32')('daemon shell proof across protocol versions', () => {
  it.each([27, 30, 35])(
    'v%i answers the shell confirm as unknown; its evidence proves the shell',
    async (protocolVersion) => {
      const request = vi.fn(async (type: string) => {
        if (type === 'confirmShellForeground') {
          throw new Error('Unknown request type: confirmShellForeground')
        }
        return SHELL_IN_FRONT
      })
      const adapter = createAdapter(protocolVersion, request)

      await expect(
        adapter.proveShellForeground('sess-a', { expectedIncarnationId: 'inc-1' })
      ).resolves.toBe('shell')
      adapter.dispose()
    }
  )

  it('does not mistake a failed shell confirm for an old daemon', async () => {
    const request = vi.fn(async (type: string) => {
      if (type === 'confirmShellForeground') {
        throw new Error('Daemon connection lost')
      }
      return SHELL_IN_FRONT
    })
    const adapter = createAdapter(35, request)

    await expect(
      adapter.proveShellForeground('sess-a', { expectedIncarnationId: 'inc-1' })
    ).rejects.toThrow('Daemon connection lost')
    adapter.dispose()
  })

  it('rejects when the daemon cannot be reached, so the row is kept', async () => {
    const request = vi.fn(async () => {
      throw new Error('Daemon connection lost')
    })
    const adapter = createAdapter(35, request)

    await expect(
      adapter.proveShellForeground('sess-a', { expectedIncarnationId: 'inc-1' })
    ).rejects.toThrow('Daemon connection lost')
    adapter.dispose()
  })
})
