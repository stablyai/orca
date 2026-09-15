// Recovery settles a worker on this answer, so every shape of doubt has to read as `false`:
// a host that says unverifiable, a host that answers about a different incarnation, a thrown
// transport, and an id no locally routed provider owns.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectExitedIncarnationFromRuntimeController } from './operations'
import { sshProviders } from '../provider/registry'
import { ptyOwnership } from '../provider/ownership-state'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'

const CONNECTION = 'exit-evidence-host'
const PTY_ID = `ssh:${CONNECTION}@@pty-1`
const INCARNATION = '45454545-4545-4545-8545-454545454545' as PtyIncarnationId
const OTHER_INCARNATION = '56565656-5656-4656-8656-565656565656' as PtyIncarnationId

function hostAnswering(inspectProcess: unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(inspectProcess as never)
  sshProviders.set(CONNECTION, { inspectProcess: spy } as never)
  return spy
}

const REMOTE_PTY_ID = 'remote:host-1/pty-1'

afterEach(() => {
  sshProviders.delete(CONNECTION)
  ptyOwnership.delete(REMOTE_PTY_ID)
})

describe('inspectExitedIncarnationFromRuntimeController', () => {
  it('accepts an exited verdict the host stamped with the requested incarnation', async () => {
    const inspect = hostAnswering(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      foregroundProcessEvidence: {
        authorityGeneration: 'gen-1',
        observationEpoch: 1,
        capturedAgeMs: 0,
        ptyId: 'pty-1',
        ptyIncarnationId: INCARNATION,
        verdict: 'exited',
        reason: 'pty_exit_0'
      }
    }))

    await expect(inspectExitedIncarnationFromRuntimeController(PTY_ID, INCARNATION)).resolves.toBe(
      true
    )
    expect(inspect).toHaveBeenCalledWith(PTY_ID, {
      expectedIncarnationId: INCARNATION
    })
  })

  it('refuses an exited verdict stamped with a different incarnation', async () => {
    hostAnswering(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      foregroundProcessEvidence: {
        authorityGeneration: 'gen-1',
        observationEpoch: 1,
        capturedAgeMs: 0,
        ptyId: 'pty-1',
        ptyIncarnationId: OTHER_INCARNATION,
        verdict: 'exited',
        reason: 'pty_exit_0'
      }
    }))

    await expect(inspectExitedIncarnationFromRuntimeController(PTY_ID, INCARNATION)).resolves.toBe(
      false
    )
  })

  it.each([
    [
      'unverifiable',
      async () => ({
        foregroundProcess: null,
        hasChildProcesses: false,
        foregroundProcessEvidence: {
          authorityGeneration: 'gen-1',
          observationEpoch: 1,
          capturedAgeMs: 0,
          ptyId: 'pty-1',
          ptyIncarnationId: INCARNATION,
          verdict: 'unverifiable',
          reason: 'incarnation_mismatch'
        }
      })
    ],
    ['no evidence at all', async () => ({ foregroundProcess: null, hasChildProcesses: false })],
    [
      'terminal_gone',
      async () => {
        throw new Error('terminal_gone')
      }
    ],
    [
      'a lost transport',
      async () => {
        throw new Error('connection lost')
      }
    ]
  ])('defers when the host answers %s', async (_label, inspectProcess) => {
    hostAnswering(inspectProcess)

    await expect(inspectExitedIncarnationFromRuntimeController(PTY_ID, INCARNATION)).resolves.toBe(
      false
    )
  })

  it('never asks a locally routed provider about a remote-scoped id', async () => {
    // Routed on purpose: without the remote-scope guard this provider WOULD answer, and its
    // verdict describes its own host, not the remote runtime that owns this session.
    const inspect = hostAnswering(async () => ({
      foregroundProcess: null,
      hasChildProcesses: false,
      foregroundProcessEvidence: {
        authorityGeneration: 'gen-1',
        observationEpoch: 1,
        capturedAgeMs: 0,
        ptyId: REMOTE_PTY_ID,
        ptyIncarnationId: INCARNATION,
        verdict: 'exited',
        reason: 'pty_exit_0'
      }
    }))
    ptyOwnership.set(REMOTE_PTY_ID, CONNECTION)

    await expect(
      inspectExitedIncarnationFromRuntimeController(REMOTE_PTY_ID, INCARNATION)
    ).resolves.toBe(false)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('defers when no provider is attached for the id', async () => {
    await expect(inspectExitedIncarnationFromRuntimeController(PTY_ID, INCARNATION)).resolves.toBe(
      false
    )
  })
})
