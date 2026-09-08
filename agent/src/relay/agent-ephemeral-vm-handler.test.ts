// src/relay/agent-ephemeral-vm-handler.test.ts
// TASK-AG-EVM-001: handleVmExec / validateVmExecParams.
// TASK-AG-EVM-002: handleVmProvision / handleVmCancelProvision.
// TASK-AG-EVM-006: handleVmSshDial / validateVmSshDialParams / hiddenTargetRegistry.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createWireState, decodeFrame } from 'orca-dev-agent-transport'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'

function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

const runRecipeCommand = vi.fn()

vi.mock('../shared/ephemeral-vm-recipe-process', () => ({
  runRecipeCommand: (...args: unknown[]) => runRecipeCommand(...args)
}))

const dialOutboundSshTarget = vi.fn()

vi.mock('./ssh-outbound-client', () => ({
  dialOutboundSshTarget: (...args: unknown[]) => dialOutboundSshTarget(...args)
}))

beforeEach(() => {
  runRecipeCommand.mockReset()
  dialOutboundSshTarget.mockReset()
})

const VALID_PARAMS = {
  repoPath: '/tmp/repo',
  command: 'echo hi',
  phase: 'suspend' as const,
  recipeId: 'recipe-1',
  runtimeId: 'runtime-1'
}

describe('validateVmExecParams', () => {
  it('returns validated params when all required fields are present and phase is valid', async () => {
    const { validateVmExecParams } = await import('./agent-ephemeral-vm-handler')
    expect(validateVmExecParams(VALID_PARAMS)).toEqual(VALID_PARAMS)
  })

  it.each(['repoPath', 'command', 'phase', 'recipeId', 'runtimeId'])(
    'throws when "%s" is missing',
    async (field) => {
      const { validateVmExecParams } = await import('./agent-ephemeral-vm-handler')
      const params = { ...VALID_PARAMS }
      delete (params as Record<string, unknown>)[field]
      expect(() => validateVmExecParams(params)).toThrow()
    }
  )

  it('throws on an invalid phase value', async () => {
    const { validateVmExecParams } = await import('./agent-ephemeral-vm-handler')
    expect(() => validateVmExecParams({ ...VALID_PARAMS, phase: 'create' })).toThrow(/phase/)
  })

  it('throws when params is undefined', async () => {
    const { validateVmExecParams } = await import('./agent-ephemeral-vm-handler')
    expect(() => validateVmExecParams(undefined)).toThrow()
  })
})

describe('handleVmExec', () => {
  it('calls runRecipeCommand with mode mapped from phase, and the right context', async () => {
    runRecipeCommand.mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0, signal: null })
    const { handleVmExec } = await import('./agent-ephemeral-vm-handler')

    const result = await handleVmExec(VALID_PARAMS)

    expect(runRecipeCommand).toHaveBeenCalledWith({
      command: VALID_PARAMS.command,
      repoPath: VALID_PARAMS.repoPath,
      mode: 'suspend',
      context: {
        recipeId: VALID_PARAMS.recipeId,
        instanceId: VALID_PARAMS.runtimeId,
        repoPath: VALID_PARAMS.repoPath
      }
    })
    expect(result).toEqual({ stdout: 'out', stderr: '', exitCode: 0 })
  })

  it.each(['resume', 'destroy'] as const)(
    'maps phase "%s" straight through to mode',
    async (phase) => {
      runRecipeCommand.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, signal: null })
      const { handleVmExec } = await import('./agent-ephemeral-vm-handler')

      await handleVmExec({ ...VALID_PARAMS, phase })

      expect(runRecipeCommand).toHaveBeenCalledWith(expect.objectContaining({ mode: phase }))
    }
  )

  it('throws with phase and tail stderr when exitCode is non-zero', async () => {
    runRecipeCommand.mockResolvedValue({
      stdout: '',
      stderr: 'boom failure',
      exitCode: 1,
      signal: null
    })
    const { handleVmExec } = await import('./agent-ephemeral-vm-handler')

    await expect(handleVmExec(VALID_PARAMS)).rejects.toThrow(/suspend/)
    await expect(handleVmExec(VALID_PARAMS)).rejects.toThrow(/boom failure/)
  })

  it('truncates stderr in the thrown message to the last 2000 characters', async () => {
    const longStderr = `${'x'.repeat(3000)}TAIL_MARKER`
    runRecipeCommand.mockResolvedValue({
      stdout: '',
      stderr: longStderr,
      exitCode: 1,
      signal: null
    })
    const { handleVmExec } = await import('./agent-ephemeral-vm-handler')

    let thrown: Error | null = null
    try {
      await handleVmExec(VALID_PARAMS)
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown?.message).toContain('TAIL_MARKER')
    expect(thrown?.message.length).toBeLessThan(2100)
  })
})

// ─── TASK-AG-EVM-002: vm.provision ──────────────────────────────────────────

class MockWs {
  readyState = 1
  sent: Buffer[] = []
  send = vi.fn((frame: Buffer) => {
    this.sent.push(frame)
  })
}

// Decodes every frame a MockWs captured, using a receiver-side WireState —
// mirrors agent-wire.test.ts's round-trip encode/decode convention (the
// encoder and decoder each need their own WireState instance).
function decodeSentFrames(ws: MockWs): unknown[] {
  const receiver = createWireState()
  return ws.sent.map((frame) => {
    const decoded = decodeFrame(receiver, frame)!
    return JSON.parse(decoded.payload.toString('utf8'))
  })
}

const VALID_PROVISION_PARAMS = {
  repoPath: '/tmp/repo',
  command: 'echo provisioning',
  recipeId: 'recipe-1',
  runtimeId: 'runtime-provision-1'
}

describe('validateVmProvisionParams', () => {
  it('returns validated params when all required fields are present', async () => {
    const { validateVmProvisionParams } = await import('./agent-ephemeral-vm-handler')
    expect(validateVmProvisionParams(VALID_PROVISION_PARAMS)).toEqual(VALID_PROVISION_PARAMS)
  })

  it.each(['repoPath', 'command', 'recipeId', 'runtimeId'])(
    'throws when "%s" is missing',
    async (field) => {
      const { validateVmProvisionParams } = await import('./agent-ephemeral-vm-handler')
      const params = { ...VALID_PROVISION_PARAMS }
      delete (params as Record<string, unknown>)[field]
      expect(() => validateVmProvisionParams(params)).toThrow()
    }
  )
})

describe('validateRuntimeIdParam', () => {
  it('returns runtimeId when present', async () => {
    const { validateRuntimeIdParam } = await import('./agent-ephemeral-vm-handler')
    expect(validateRuntimeIdParam({ runtimeId: 'r1' })).toEqual({ runtimeId: 'r1' })
  })

  it('throws when runtimeId is missing', async () => {
    const { validateRuntimeIdParam } = await import('./agent-ephemeral-vm-handler')
    expect(() => validateRuntimeIdParam({})).toThrow()
  })
})

describe('handleVmProvision', () => {
  it('sends N stream.chunk frames then 1 stream.end frame, all sharing the request id', async () => {
    runRecipeCommand.mockImplementation(
      async (args: { onStdout?: (c: string) => void; onStderr?: (c: string) => void }) => {
        args.onStdout?.('line 1')
        args.onStdout?.('line 2')
        args.onStderr?.('warn 1')
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            pairingCode: 'ABCD-EFGH',
            projectRoot: '/root'
          }),
          stderr: '',
          exitCode: 0,
          signal: null
        }
      }
    )
    const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
    const ws = new MockWs()
    const wireState = createWireState()

    await handleVmProvision(ws as unknown as never, wireState, 'req-1', VALID_PROVISION_PARAMS)

    const frames = decodeSentFrames(ws)
    expect(frames).toHaveLength(4)
    expect(frames[0]).toMatchObject({
      id: 'req-1',
      result: { type: 'stream.chunk', line: 'line 1' }
    })
    expect(frames[1]).toMatchObject({
      id: 'req-1',
      result: { type: 'stream.chunk', line: 'line 2' }
    })
    expect(frames[2]).toMatchObject({
      id: 'req-1',
      result: { type: 'stream.chunk', line: 'warn 1', source: 'stderr' }
    })
    expect(frames[3]).toMatchObject({ id: 'req-1', result: { type: 'stream.end', exitCode: 0 } })
  })

  it('parses provisionResult for the orca-server connection branch', async () => {
    const pairingCode = makePairingCode()
    runRecipeCommand.mockResolvedValue({
      stdout: JSON.stringify({ schemaVersion: 1, pairingCode, projectRoot: '/root' }),
      stderr: '',
      exitCode: 0,
      signal: null
    })
    const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
    const ws = new MockWs()

    await handleVmProvision(ws as unknown as never, createWireState(), 1, VALID_PROVISION_PARAMS)

    const frames = decodeSentFrames(ws) as { result: { type: string; provisionResult?: unknown } }[]
    const end = frames.find((f) => f.result.type === 'stream.end')!
    expect(end.result.provisionResult).toEqual({
      ok: true,
      result: { schemaVersion: 1, pairingCode, projectRoot: '/root' }
    })
  })

  it('parses provisionResult for the ssh connection branch', async () => {
    const sshResult = {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        target: { label: 'vm-1', host: 'vm1.example.com', port: 22, username: 'root' },
        projectRoot: '/root'
      }
    }
    runRecipeCommand.mockResolvedValue({
      stdout: JSON.stringify(sshResult),
      stderr: '',
      exitCode: 0,
      signal: null
    })
    const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
    const ws = new MockWs()

    await handleVmProvision(ws as unknown as never, createWireState(), 1, VALID_PROVISION_PARAMS)

    const frames = decodeSentFrames(ws) as { result: { type: string; provisionResult?: unknown } }[]
    const end = frames.find((f) => f.result.type === 'stream.end')!
    expect(end.result.provisionResult).toEqual({ ok: true, result: sshResult })
  })

  it('reports a non-zero exitCode via stream.end without throwing out of the dispatch loop', async () => {
    runRecipeCommand.mockResolvedValue({
      stdout: 'not json',
      stderr: 'boom',
      exitCode: 7,
      signal: null
    })
    const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
    const ws = new MockWs()

    await expect(
      handleVmProvision(ws as unknown as never, createWireState(), 1, VALID_PROVISION_PARAMS)
    ).resolves.toBeUndefined()

    const frames = decodeSentFrames(ws) as { result: { type: string; exitCode?: number } }[]
    const end = frames.find((f) => f.result.type === 'stream.end')!
    expect(end.result.exitCode).toBe(7)
  })

  it('sends a stream.end with exitCode -1 and an error message if runRecipeCommand itself rejects', async () => {
    runRecipeCommand.mockRejectedValue(new Error('spawn failed'))
    const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
    const ws = new MockWs()

    await handleVmProvision(ws as unknown as never, createWireState(), 1, VALID_PROVISION_PARAMS)

    const frames = decodeSentFrames(ws) as {
      result: { type: string; exitCode?: number; error?: string }
    }[]
    expect(frames).toHaveLength(1)
    expect(frames[0].result).toMatchObject({
      type: 'stream.end',
      exitCode: -1,
      error: expect.stringContaining('spawn failed')
    })
  })

  it('aborts the runRecipeCommand signal once DEFAULT_PROVISION_TIMEOUT_MS elapses', async () => {
    vi.useFakeTimers()
    try {
      let capturedSignal: AbortSignal | undefined
      runRecipeCommand.mockImplementation(
        (args: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            capturedSignal = args.signal
            args.signal?.addEventListener('abort', () => {
              resolve({ stdout: '{}', stderr: '', exitCode: -1, signal: 'SIGTERM' })
            })
          })
      )
      const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
      const ws = new MockWs()

      const pending = handleVmProvision(
        ws as unknown as never,
        createWireState(),
        1,
        VALID_PROVISION_PARAMS
      )
      expect(capturedSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      await pending

      expect(capturedSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps two concurrent provisions for different runtimeIds independent in the abort registry', async () => {
    const deferred: Record<string, { resolve: (v: unknown) => void; signal?: AbortSignal }> = {}
    runRecipeCommand.mockImplementation(
      (args: { context: { instanceId?: string }; signal?: AbortSignal }) =>
        new Promise((resolve) => {
          deferred[args.context.instanceId ?? ''] = { resolve, signal: args.signal }
        })
    )
    const { handleVmProvision, handleVmCancelProvision } =
      await import('./agent-ephemeral-vm-handler')
    const wsA = new MockWs()
    const wsB = new MockWs()

    const pendingA = handleVmProvision(wsA as unknown as never, createWireState(), 1, {
      ...VALID_PROVISION_PARAMS,
      runtimeId: 'runtime-A'
    })
    const pendingB = handleVmProvision(wsB as unknown as never, createWireState(), 2, {
      ...VALID_PROVISION_PARAMS,
      runtimeId: 'runtime-B'
    })

    const cancelResult = await handleVmCancelProvision({ runtimeId: 'runtime-A' })
    expect(cancelResult).toEqual({ cancelled: true })
    expect(deferred['runtime-A'].signal?.aborted).toBe(true)
    expect(deferred['runtime-B'].signal?.aborted).toBe(false)

    deferred['runtime-A'].resolve({ stdout: '{}', stderr: '', exitCode: -1, signal: null })
    deferred['runtime-B'].resolve({ stdout: '{}', stderr: '', exitCode: 0, signal: null })
    await Promise.all([pendingA, pendingB])
  })
})

describe('handleVmCancelProvision', () => {
  it('returns {cancelled: false} without error when no provision is running for that runtimeId', async () => {
    const { handleVmCancelProvision } = await import('./agent-ephemeral-vm-handler')
    await expect(handleVmCancelProvision({ runtimeId: 'no-such-runtime' })).resolves.toEqual({
      cancelled: false
    })
  })
})

// ─── TASK-AG-EVM-006: vm.sshDial / hiddenTargetRegistry ─────────────────────

const VALID_SSH_TARGET = {
  label: 'vm-1',
  host: 'vm1.example.com',
  port: 22,
  username: 'deploy'
}

function makeFakeSession(): { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn() }
}

// Real backend-go wire shape (infra-fleet-service's DialHiddenSshTarget,
// TASK-BE-EVM-014) — flat, no `label`, credential nested as
// `target.privateKeyPem`. Regression-guard fixture for the CR-EVM-005
// cross-side reconciliation bug found 2026-09-08: the earlier version of
// validateVmSshDialParams parsed against EphemeralVmRecipeSshTargetSchema
// (requires `label`) and read credential from a top-level `privateKeyPEM`
// sibling — backend-go's real params matched neither, so every real
// vm.sshDial call from backend-go was rejected outright.
const BACKEND_GO_WIRE_PARAMS = {
  runtimeId: 'runtime-1',
  target: {
    host: 'vm1.example.com',
    port: 22,
    username: 'deploy',
    privateKeyPem: 'PEM-FROM-VAULT',
    identityAgentSocket: '/tmp/ssh-agent.sock',
    jumpHost: 'bastion.example.com',
    proxyCommand: 'cloudflared access ssh --hostname %h'
  }
}

describe('validateVmSshDialParams', () => {
  it("accepts backend-go's real wire shape — no label, privateKeyPem nested in target", async () => {
    const { validateVmSshDialParams } = await import('./agent-ephemeral-vm-handler')
    const result = validateVmSshDialParams(BACKEND_GO_WIRE_PARAMS)
    expect(result).toEqual({
      runtimeId: 'runtime-1',
      privateKeyPEM: 'PEM-FROM-VAULT',
      target: {
        host: 'vm1.example.com',
        port: 22,
        username: 'deploy',
        identityAgent: '/tmp/ssh-agent.sock',
        jumpHost: 'bastion.example.com',
        proxyCommand: 'cloudflared access ssh --hostname %h'
      }
    })
  })

  it('also accepts the legacy shape (top-level privateKeyPEM, label present but ignored)', async () => {
    const { validateVmSshDialParams } = await import('./agent-ephemeral-vm-handler')
    const params = { runtimeId: 'runtime-1', target: VALID_SSH_TARGET, privateKeyPEM: 'PEM' }
    const result = validateVmSshDialParams(params)
    expect(result.runtimeId).toBe('runtime-1')
    expect(result.privateKeyPEM).toBe('PEM')
    expect(result.target).toEqual({
      host: VALID_SSH_TARGET.host,
      port: VALID_SSH_TARGET.port,
      username: VALID_SSH_TARGET.username,
      identityAgent: undefined,
      jumpHost: undefined,
      proxyCommand: undefined
    })
  })

  it('allows privateKeyPEM to be omitted (identityAgent-only dial)', async () => {
    const { validateVmSshDialParams } = await import('./agent-ephemeral-vm-handler')
    const result = validateVmSshDialParams({ runtimeId: 'runtime-1', target: VALID_SSH_TARGET })
    expect(result.privateKeyPEM).toBeUndefined()
  })

  it('throws when runtimeId is missing', async () => {
    const { validateVmSshDialParams } = await import('./agent-ephemeral-vm-handler')
    expect(() => validateVmSshDialParams({ target: VALID_SSH_TARGET })).toThrow()
  })

  it('throws when target.host is missing', async () => {
    const { validateVmSshDialParams } = await import('./agent-ephemeral-vm-handler')
    expect(() =>
      validateVmSshDialParams({ runtimeId: 'runtime-1', target: { username: 'root', port: 22 } })
    ).toThrow(/host/)
  })

  it('throws when target.port is not a valid positive number', async () => {
    const { validateVmSshDialParams } = await import('./agent-ephemeral-vm-handler')
    expect(() =>
      validateVmSshDialParams({
        runtimeId: 'runtime-1',
        target: { host: 'x', username: 'root', port: 'not-a-number' }
      })
    ).toThrow(/port/)
  })
})

describe('handleVmSshDial', () => {
  it('dials and registers the session in hiddenTargetRegistry under runtimeId', async () => {
    const session = makeFakeSession()
    dialOutboundSshTarget.mockResolvedValue(session)
    const { handleVmSshDial, hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')

    const result = await handleVmSshDial({
      runtimeId: 'runtime-ssh-1',
      target: VALID_SSH_TARGET,
      privateKeyPEM: 'PEM-DATA'
    })

    expect(result).toEqual({ hiddenTargetId: 'runtime-ssh-1' })
    expect(dialOutboundSshTarget).toHaveBeenCalledWith(VALID_SSH_TARGET, {
      privateKeyPEM: 'PEM-DATA'
    })
    expect(hiddenTargetRegistry.get('runtime-ssh-1')).toBe(session)
  })

  it('re-dialing the same runtimeId overwrites the registry entry and closes the stale session', async () => {
    const firstSession = makeFakeSession()
    const secondSession = makeFakeSession()
    dialOutboundSshTarget.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession)
    const { handleVmSshDial, hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')

    await handleVmSshDial({ runtimeId: 'runtime-reconnect', target: VALID_SSH_TARGET })
    expect(hiddenTargetRegistry.get('runtime-reconnect')).toBe(firstSession)

    // Simulates backend-go re-issuing vm.sshDial after an agent restart —
    // must not throw because of leftover state, and must replace the entry.
    await handleVmSshDial({ runtimeId: 'runtime-reconnect', target: VALID_SSH_TARGET })

    expect(hiddenTargetRegistry.get('runtime-reconnect')).toBe(secondSession)
    expect(firstSession.close).toHaveBeenCalledOnce()
    expect(secondSession.close).not.toHaveBeenCalled()
  })

  it('keeps two different runtimeIds independent in the registry', async () => {
    const sessionA = makeFakeSession()
    const sessionB = makeFakeSession()
    dialOutboundSshTarget.mockResolvedValueOnce(sessionA).mockResolvedValueOnce(sessionB)
    const { handleVmSshDial, hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')

    await handleVmSshDial({ runtimeId: 'runtime-A', target: VALID_SSH_TARGET })
    await handleVmSshDial({ runtimeId: 'runtime-B', target: VALID_SSH_TARGET })

    expect(hiddenTargetRegistry.get('runtime-A')).toBe(sessionA)
    expect(hiddenTargetRegistry.get('runtime-B')).toBe(sessionB)
  })

  it('propagates a dial failure without registering anything', async () => {
    dialOutboundSshTarget.mockRejectedValue(new Error('ECONNREFUSED'))
    const { handleVmSshDial, hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')

    await expect(
      handleVmSshDial({ runtimeId: 'runtime-fail', target: VALID_SSH_TARGET })
    ).rejects.toThrow('ECONNREFUSED')
    expect(hiddenTargetRegistry.has('runtime-fail')).toBe(false)
  })
})

// ─── Security regression-guard: privateKeyPEM must never surface in a
// thrown error/log out of handleVmSshDial, even if the lower layer
// (ssh-outbound-client.ts, mocked away in this file) fails to scrub it
// itself. This is the RPC boundary — the last chance before the message
// reaches agent-rpc-dispatch-misc.ts's makeError() and a log/wire response.
describe('handleVmSshDial — privateKeyPEM never appears in a thrown error', () => {
  it('scrubs privateKeyPEM out of the error message when the mocked dial layer leaks it unscrubbed', async () => {
    const secret = 'SUPER-SECRET-PRIVATE-KEY-PEM-CONTENTS'
    dialOutboundSshTarget.mockRejectedValue(new Error(`ssh2 auth failed using key ${secret}`))
    const { handleVmSshDial } = await import('./agent-ephemeral-vm-handler')

    let thrown: Error | null = null
    try {
      await handleVmSshDial({
        runtimeId: 'runtime-leak',
        target: VALID_SSH_TARGET,
        privateKeyPEM: secret
      })
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).not.toBeNull()
    expect(thrown!.message).not.toContain(secret)
    expect(thrown!.message).toContain('[REDACTED]')
  })

  it('leaves an unrelated dial failure message untouched', async () => {
    dialOutboundSshTarget.mockRejectedValue(new Error('ETIMEDOUT connecting to vm1.example.com'))
    const { handleVmSshDial } = await import('./agent-ephemeral-vm-handler')

    await expect(
      handleVmSshDial({
        runtimeId: 'runtime-timeout',
        target: VALID_SSH_TARGET,
        privateKeyPEM: 'unrelated-secret'
      })
    ).rejects.toThrow('ETIMEDOUT connecting to vm1.example.com')
  })
})
