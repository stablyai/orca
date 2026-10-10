import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_RECOVERY_CHANGED_STATE_CODE } from '../../shared/orcad-managed-runtime'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { RuntimeClientError } from '../runtime-client'
import { MANAGED_SERVER_ACTION_TIMEOUT_MS, MANAGED_SERVER_HANDLERS } from './managed-server'

function envelope(result: unknown) {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function client(result: unknown, capabilities = [MANAGED_SERVER_RUNTIME_CAPABILITY]) {
  return vi.fn(async (method: string) =>
    method === 'status.get' ? envelope({ capabilities }) : envelope(result)
  )
}

async function run(
  command: string,
  call: ReturnType<typeof client>,
  flags: [string, string | boolean][]
) {
  const handler = MANAGED_SERVER_HANDLERS[command]
  if (!handler) {
    throw new Error(`no handler for ${command}`)
  }
  await handler({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only call client.call.
    client: { call } as never,
    cwd: '/tmp',
    flags: new Map([['environment', 'build-box'], ...flags]),
    json: false
  })
}

afterEach(() => vi.restoreAllMocks())

describe('managed server CLI verbs', () => {
  it('refuses on a runtime that does not advertise managed servers, before calling the action', async () => {
    const call = client({ outcome: 'none' }, [])
    await expect(run('environment recover', call, [])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('reads an older runtime’s method_not_found as the same refusal', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return envelope({ capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] })
      }
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    await expect(run('environment status', call, [])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })

  it('needs --yes before stopping, and then calls the same stop the settings use', async () => {
    const stopped = {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: 'env-1',
      sshTargetId: 'ssh-1',
      stoppedVersion: '1.0.0',
      retirement: null
    }
    const unconfirmed = client(stopped)
    await expect(run('environment stop', unconfirmed, [])).rejects.toMatchObject({
      code: 'confirmation_required'
    })
    expect(unconfirmed).not.toHaveBeenCalled()

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const confirmed = client(stopped)
    await run('environment stop', confirmed, [['yes', true]])
    expect(confirmed).toHaveBeenCalledWith(
      'managedServer.stop',
      { selector: 'build-box' },
      { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }
    )
    expect(log).toHaveBeenCalledWith('Stopped build-box and unlinked it from this machine.')
  })

  it('forgets a server only with --yes, over its own method (P1-E)', async () => {
    const forgotten = {
      outcome: 'forgotten',
      verdict: 'unverifiable',
      environmentId: 'env-1',
      sshTargetId: 'ssh-1'
    }
    const unconfirmed = client(forgotten)
    await expect(run('environment forget', unconfirmed, [])).rejects.toMatchObject({
      code: 'confirmation_required'
    })
    expect(unconfirmed).not.toHaveBeenCalled()

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const confirmed = client(forgotten)
    await run('environment forget', confirmed, [['yes', true]])
    // Never managedServer.stop: an older desktop would drop a flag and decommission instead.
    expect(confirmed).toHaveBeenCalledWith(
      'managedServer.forget',
      { selector: 'build-box' },
      { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('may still be running there'))
  })

  it('fails the command with the refusal, so scripts see a non-zero exit', async () => {
    const refusal = {
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_stop_active_environment',
      reason: 'Choose another Active Server in Advanced before stopping this server.'
    }
    await expect(run('environment stop', client(refusal), [['yes', true]])).rejects.toMatchObject({
      code: 'managed_server_refused',
      message: refusal.reason,
      data: refusal
    })
  })

  it('passes --force to an update, and reports a deferred one as unsettled', async () => {
    const call = client({
      outcome: 'deferred',
      candidateVersion: '2.0.0',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are running.'
    })
    await expect(run('environment update', call, [])).rejects.toMatchObject({
      code: 'managed_server_deferred'
    })
    expect(call).toHaveBeenCalledWith(
      'managedServer.update',
      { selector: 'build-box', force: false },
      { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }
    )

    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const forced = client({
      outcome: 'updated',
      environment: { name: 'build-box' },
      activeVersion: '2.0.0'
    })
    await run('environment update', forced, [['force', true]])
    expect(forced).toHaveBeenCalledWith(
      'managedServer.update',
      { selector: 'build-box', force: true },
      { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }
    )
  })

  it('fails on an outcome a newer desktop added instead of printing undefined', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(
      run('environment cancel-stop', client({ outcome: 'future-outcome' }), [])
    ).rejects.toMatchObject({ code: 'managed_server_future-outcome' })
    expect(log).not.toHaveBeenCalled()
  })

  it('prints a readable status', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await run(
      'environment status',
      client({
        activeVersion: '1.0.0',
        previousVersion: '0.9.0',
        rollbackAvailable: true,
        recovery: null,
        terminals: { liveSessions: null },
        migration: null,
        deferredUpdate: null
      }),
      []
    )
    expect(log.mock.calls[0]?.[0]).toBe(
      'Active version: 1.0.0\nPrevious version: 0.9.0 (rollback available)\nLive terminals: unverifiable'
    )
  })

  it('gives mutating actions a budget past the desktop’s own deadlines, and status the default', async () => {
    const stopped = {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: 'env-1',
      sshTargetId: 'ssh-1',
      stoppedVersion: '1.0.0',
      retirement: null
    }
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const stop = client(stopped)
    await run('environment stop', stop, [['yes', true]])
    expect(stop).toHaveBeenCalledWith(
      'managedServer.stop',
      { selector: 'build-box' },
      { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }
    )
    const status = client({
      activeVersion: '1.0.0',
      previousVersion: null,
      rollbackAvailable: false,
      recovery: null,
      terminals: { liveSessions: 0 },
      migration: null,
      deferredUpdate: null
    })
    await run('environment status', status, [])
    expect(status).toHaveBeenCalledWith(
      'managedServer.status',
      { selector: 'build-box' },
      undefined
    )
  })

  it('reports a timed-out action as possibly still running, never as a failure of the action', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return envelope({ capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] })
      }
      throw new RuntimeClientError(
        'runtime_timeout',
        'Timed out waiting for the Orca runtime to respond.'
      )
    })
    await expect(run('environment update', call, [])).rejects.toMatchObject({
      code: 'managed_server_in_progress',
      message: expect.stringContaining('orca environment status')
    })
  })

  // BUG-21: an update restarts the server, so the call's connection closes before it answers.
  it('reports what a restarting update left behind instead of failing on the closed connection', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let updated = false
    const call = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return envelope({ capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] })
      }
      if (method === 'managedServer.update') {
        updated = true
        throw new RuntimeClientError(
          'runtime_unavailable',
          'The Orca runtime closed the connection before responding.'
        )
      }
      return envelope({ activeVersion: '0.2.0+bb01', recovery: null, deferredUpdate: null })
    })
    try {
      const done = run('environment update', call, [])
      await vi.advanceTimersByTimeAsync(2_000)
      await done
      expect(updated).toBe(true)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('now runs 0.2.0+bb01'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an update the restart left interrupted as needing recover', async () => {
    vi.useFakeTimers()
    const call = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return envelope({ capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] })
      }
      if (method === 'managedServer.update') {
        throw new RuntimeClientError('runtime_unavailable', 'closed')
      }
      return envelope({
        activeVersion: '0.1.0+aa01',
        recovery: { operation: 'activate', version: '0.2.0+bb01', phase: 'snapshot-captured' },
        deferredUpdate: null
      })
    })
    try {
      const done = run('environment update', call, []).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await done).toMatchObject({ code: 'managed_server_interrupted' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores changed state only with --accept-changed-state --yes, and its refusal names the flags', async () => {
    const refusal = {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: ORCAD_RECOVERY_CHANGED_STATE_CODE,
      reason: 'The launched build changed profile state. Recover to restore the prelaunch snapshot.'
    }
    await expect(run('environment recover', client(refusal), [])).rejects.toMatchObject({
      code: 'managed_server_refused',
      message: expect.stringContaining('--accept-changed-state --yes')
    })

    const unconfirmed = client({ outcome: 'none' })
    await expect(
      run('environment recover', unconfirmed, [['accept-changed-state', true]])
    ).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(unconfirmed).not.toHaveBeenCalled()

    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const confirmed = client({ outcome: 'none' })
    await run('environment recover', confirmed, [
      ['accept-changed-state', true],
      ['yes', true]
    ])
    expect(confirmed).toHaveBeenCalledWith(
      'managedServer.recover',
      { selector: 'build-box', acceptChangedState: true },
      { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }
    )
  })
})
