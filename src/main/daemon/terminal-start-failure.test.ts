import './mock-descendant-sweep'
import { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { Session } from './session'
import { DaemonTerminalAdmission } from './daemon-terminal-admission'
import { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import { answerDaemonControlRequest } from './daemon-control-request'
import { DaemonPendingRequests } from './daemon-client-pending-requests'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  formatTerminalStartFailure,
  readTerminalStartFailure,
  terminalStartError
} from '../../shared/terminal-start-failure'
import { mapRuntimeError } from '../runtime/rpc/errors'

const MARKER = 'too many consoles in use, max consoles is 128'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.restoreAllMocks()
})

function subprocess(cause?: TerminalExitCause): SubprocessHandle {
  return {
    pid: 12345,
    shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(),
    signal: vi.fn(),
    dispose: vi.fn(),
    onData: (cb) => {
      cb('console allocation failure: too many consoles ')
      cb('in use, max consoles is 128')
    },
    onExit: (cb) => cb(256, cause)
  }
}

describe('process-owned terminal startup failure', () => {
  it('rejects constructor-time death through the real daemon error reply without publishing a phantom terminal', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const events = vi.fn()
    const sub = subprocess({
      kind: 'exited',
      exitCode: 256,
      initialOutputDiagnostic: 'git-bash-console-capacity'
    })
    const host = new TerminalHost({ spawnSubprocess: () => sub, reportReadinessEvent: events })
    const socket = new Socket()
    const write = vi.spyOn(socket, 'write').mockReturnValue(true)
    try {
      const preparations = new DaemonPtySpawnPreparations(async () => {})
      const finish = vi.spyOn(preparations, 'finish')
      const attach = vi.fn()
      // SAFETY: constructor-time rejection reaches only these admission dependencies; success-only dependencies must remain unused.
      const options = {
        host,
        preparations,
        connections: { get: () => ({ authenticatedPairEstablished: true, streamSocket: socket }) },
        endpoint: { hasLostOwnership: () => false },
        attachments: { attach },
        isAcceptingWork: () => true,
        reevaluateIdleShutdown: vi.fn()
      } as unknown as ConstructorParameters<typeof DaemonTerminalAdmission>[0]
      const admission = new DaemonTerminalAdmission(options)
      const request = {
        id: 'start',
        type: 'createOrAttach',
        payload: {
          sessionId: 'capacity',
          cols: 80,
          rows: 24,
          command: 'private-command-token'
        }
      } as const
      await answerDaemonControlRequest(
        socket,
        request,
        () => admission.createOrAttach('client', request),
        vi.fn()
      )
      expect(admission.inFlight).toBe(0)
      expect(finish).toHaveBeenCalledOnce()
      expect(attach).not.toHaveBeenCalled()
      expect(write).toHaveBeenCalledOnce()
      const payload = String(write.mock.calls[0]?.[0])
      const response = JSON.parse(payload)
      expect(response).toMatchObject({
        ok: false,
        error: 'agent_session_exited_during_start',
        terminalStartFailure: {
          incarnationId: expect.any(String),
          cause: {
            kind: 'exited',
            exitCode: 256,
            initialOutputDiagnostic: 'git-bash-console-capacity'
          }
        }
      })
      const pending = new DaemonPendingRequests()
      const rejection = Promise.withResolvers<unknown>()
      pending.add('start', {
        resolve: rejection.resolve,
        reject: rejection.resolve,
        timer: setTimeout(() => {}, 1000)
      })
      pending.settle(response)
      const error = await rejection.promise
      expect(mapRuntimeError('rpc', { runtimeId: 'runtime' }, error)).toMatchObject({
        error: {
          code: 'agent_session_exited_during_start',
          message: expect.stringContaining('Close some Git Bash terminals')
        }
      })
      expect(host.listSessions()).toEqual([])
      expect(sub.write).not.toHaveBeenCalled()
      expect(sub.kill).not.toHaveBeenCalled()
      expect(sub.forceKill).not.toHaveBeenCalled()
      expect(
        events.mock.calls.filter(([event]) => event === 'session-initial-output-diagnostic')
      ).toHaveLength(1)
      expect(payload + JSON.stringify(events.mock.calls)).not.toContain('private-command-token')
      expect(payload).not.toContain(MARKER)
    } finally {
      socket.destroy()
      await host.dispose()
    }
  })

  it.each([
    { kind: 'operator_close' },
    { kind: 'signaled', signal: 9 },
    { kind: 'unknown', reason: 'host_status_unavailable' },
    { kind: 'exited', exitCode: 0 }
  ] as const)('keeps $kind exits unclassified despite matching output', (cause) => {
    const session = new Session({
      sessionId: 'control',
      cols: 80,
      rows: 24,
      subprocess: subprocess(cause),
      ownerBackend: 'windows-conpty',
      shellReadySupported: false
    })
    expect(
      formatTerminalStartFailure(
        terminalStartError('agent_session_exited_during_start', session.exitCause)
      )
    ).toBeUndefined()
    session.dispose()
  })

  it.each(['posix-pty', 'windows-wsl'] as const)('does not classify %s output', (ownerBackend) => {
    const session = new Session({
      sessionId: 'control',
      cols: 80,
      rows: 24,
      subprocess: subprocess({ kind: 'exited', exitCode: 256 }),
      ownerBackend,
      shellReadySupported: false
    })
    expect(
      readTerminalStartFailure(
        terminalStartError('agent_session_exited_during_start', session.exitCause)
      )
    ).toBeUndefined()
    session.dispose()
  })
})
