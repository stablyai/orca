import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error && error.message === 'unconfirmed'
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { launchOrcadAndAwaitReadiness } from './orcad-remote-runtime-control'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { OrcadLaunchSpec } from './orcad-remote-launch'
import { createSshOperationAbortError } from '../../ssh/connection/ssh-exec-options'
import { launchOrcadSlotAndAwaitReadiness } from '../../ssh/orcad-active-readiness'

const host = getRemoteHostPlatform('linux-arm64')
const spec: OrcadLaunchSpec = {
  remoteInstallDir: '/root/.orca-remote/orcad-0.1.0+07d0995735e0',
  nodePath: '/usr/bin/node',
  fullVersion: '0.1.0+07d0995735e0',
  userDataDir: '/root/.orca',
  bindHost: '127.0.0.1',
  port: 6768,
  activationRoot: '/root/.orca-remote/.orcad-activation-transaction'
}
const READY = `${JSON.stringify({ type: 'orca_server_ready', runtimeId: 'r1' })}\n`
const mockExec = vi.mocked(execCommand)

function launch(signal?: AbortSignal) {
  return launchOrcadAndAwaitReadiness(
    { conn: Object.create(null), host, readinessTimeoutMs: 60_000, sleep: async () => {}, signal },
    spec
  )
}

describe('waiting for a launched candidate', () => {
  beforeEach(() => {
    mockExec.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('retries a failed readiness read instead of failing the launch', async () => {
    mockExec
      .mockResolvedValueOnce('1786\n')
      .mockRejectedValueOnce(new Error('(SSH) Channel open failure: open failed'))
      .mockResolvedValueOnce(READY)
    await expect(launch()).resolves.toMatchObject({
      state: 'ready',
      readiness: { runtimeId: 'r1' }
    })
  })

  it('still fails at once on an unconfirmed termination, which may have run remotely', async () => {
    mockExec.mockResolvedValueOnce('1786\n').mockRejectedValueOnce(new Error('unconfirmed'))
    await expect(launch()).rejects.toThrow('unconfirmed')
  })

  it('stops retrying a readiness read that the retired SSH transport cancelled', async () => {
    const cancelled = createSshOperationAbortError()
    mockExec
      .mockResolvedValueOnce('1786\n')
      .mockRejectedValueOnce(cancelled)
      .mockResolvedValueOnce(READY)
    await expect(launch()).rejects.toBe(cancelled)
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('rejects a readiness reply received after its caller cancelled', async () => {
    const controller = new AbortController()
    mockExec.mockResolvedValueOnce('1786\n').mockImplementationOnce(async () => {
      controller.abort()
      return READY
    })
    await expect(launch(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('a launch that exits before it is ready', () => {
  const REFUSAL = 'orcad: failed to start: another machine may hold the data root'
  let now = 0
  beforeEach(() => {
    mockExec.mockReset()
    now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })

  // The host answers each wait at once; only the client's injected sleep moves the clock.
  function waitAnswers(exitedOnPoll: number | null) {
    let polls = 0
    mockExec.mockImplementation(async (_conn, command) => {
      if (command.includes('tail -c')) {
        return `${REFUSAL}\n`
      }
      if (command.includes('orcad_readiness_wait_end')) {
        polls += 1
        return polls === exitedOnPoll ? 'ORCAD_LAUNCH_EXITED\n' : ''
      }
      return '1786\n'
    })
    return () => polls
  }

  function launchSlot() {
    return launchOrcadSlotAndAwaitReadiness(
      {
        conn: Object.create(null),
        host,
        readinessTimeoutMs: 180_000,
        sleep: async (ms) => {
          now += ms
        }
      },
      spec,
      { fullVersion: spec.fullVersion, buildHash: 'b1' }
    )
  }

  it('fails at once with the log’s refusal once the host proved the PID gone', async () => {
    const polls = waitAnswers(2)
    const failure = launchSlot()
    await expect(failure).rejects.toMatchObject({ verdict: 'rejected' })
    await expect(failure).rejects.toThrow(REFUSAL)
    expect(polls()).toBe(2)
    expect(now).toBeLessThan(5_000)
  })

  it('waits out the deadline when the host never proves an exit', async () => {
    const polls = waitAnswers(null)
    await expect(launchSlot()).rejects.toThrow(REFUSAL)
    expect(now).toBeGreaterThanOrEqual(180_000)
    expect(polls()).toBeGreaterThan(100)
  })
})
