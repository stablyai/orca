// The client half of #17830: a spawn refused for an unloadable node-pty must route into a repair
// instead of printing a paragraph. Covers the seam only — the ledger and the locked rebuild are
// tested in src/main/ssh/ssh-relay-node-pty-repair.test.ts and
// src/main/ssh/ssh-relay-node-pty-spawn-repair.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { createMockMux, type MockMultiplexer } from './ssh-pty-provider-mock-multiplexer'
import {
  TERMINAL_UNAVAILABLE_RPC_ERROR_CODE,
  type TerminalUnavailableCause
} from '../../shared/terminal-unavailable-cause'

const UNAVAILABLE_MESSAGE =
  "Remote terminals are unavailable: this host's node-pty binary was built for Node ABI 108."

function cause(overrides: Partial<TerminalUnavailableCause> = {}): TerminalUnavailableCause {
  return {
    status: 'blocked',
    reason: 'abi_mismatch',
    detail: 'built for NODE_MODULE_VERSION 108, this Node accepts 115',
    repairable: true,
    host: {
      platform: 'linux',
      arch: 'x64',
      libc: 'glibc',
      glibcVersion: '2.31',
      nodeAbi: '115',
      nodeVersion: 'v20.11.0'
    },
    ...overrides
  }
}

/** Shaped exactly as the multiplexer rebuilds a JSON-RPC error response client-side. */
function relayRejection(data: unknown): Error {
  const error = new Error(UNAVAILABLE_MESSAGE)
  Object.defineProperty(error, 'code', { value: TERMINAL_UNAVAILABLE_RPC_ERROR_CODE })
  Object.defineProperty(error, 'data', { value: data })
  return error
}

function spawnCallCount(target: MockMultiplexer): number {
  return target.request.mock.calls.filter((call) => call[0] === 'pty.spawn').length
}

function rejectSpawnOnce(mux: MockMultiplexer, error: Error): void {
  mux.request.mockImplementation(async (method: string) => {
    if (method === 'pty.spawn') {
      throw error
    }
    return undefined
  })
}

const SPAWN_OPTS = { cwd: '/repo', cols: 80, rows: 24 }

let mux: MockMultiplexer
let provider: SshPtyProvider

beforeEach(() => {
  mux = createMockMux()
  provider = new SshPtyProvider('conn-1', mux as never)
})

describe('terminal-unavailable spawn recovery', () => {
  it('routes a repairable cause into recovery and retries once on the repaired provider', async () => {
    rejectSpawnOnce(mux, relayRejection(cause()))
    const repairedMux = createMockMux()
    repairedMux.request.mockResolvedValue({ id: 'pty-1', incarnationId: 'incarnation-1' })
    const repairedProvider = new SshPtyProvider('conn-1', repairedMux as never)
    const recover = vi.fn(async () => repairedProvider)
    provider.setTerminalUnavailableRecovery(recover)

    const result = await provider.spawn(SPAWN_OPTS)

    expect(result.id).toBe('ssh:conn-1@@pty-1')
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'abi_mismatch', status: 'blocked' })
    )
    // Exactly one retry, on the post-repair channel — never a second attempt on the broken one.
    expect(spawnCallCount(mux)).toBe(1)
    expect(spawnCallCount(repairedMux)).toBe(1)
  })

  it('surfaces the relay message when the retry still fails, and does not recurse into a second repair', async () => {
    // The lock-busy shape: the reconnect happened, the rebuild did not, so the relay says the same thing.
    rejectSpawnOnce(mux, relayRejection(cause()))
    const degradedMux = createMockMux()
    const degradedProvider = new SshPtyProvider('conn-1', degradedMux as never)
    rejectSpawnOnce(degradedMux, relayRejection(cause()))
    const degradedRecover = vi.fn(async () => degradedProvider)
    degradedProvider.setTerminalUnavailableRecovery(degradedRecover)
    const recover = vi.fn(async () => degradedProvider)
    provider.setTerminalUnavailableRecovery(recover)

    await expect(provider.spawn(SPAWN_OPTS)).rejects.toThrow(UNAVAILABLE_MESSAGE)

    expect(recover).toHaveBeenCalledTimes(1)
    expect(degradedRecover).not.toHaveBeenCalled()
  })

  it('rethrows without recovery when the recovery declines', async () => {
    rejectSpawnOnce(mux, relayRejection(cause()))
    provider.setTerminalUnavailableRecovery(async () => null)

    await expect(provider.spawn(SPAWN_OPTS)).rejects.toThrow(UNAVAILABLE_MESSAGE)
  })

  it('never recovers from an unverifiable cause', async () => {
    rejectSpawnOnce(mux, relayRejection(cause({ status: 'unverifiable', repairable: true })))
    const recover = vi.fn(async () => provider)
    provider.setTerminalUnavailableRecovery(recover)

    await expect(provider.spawn(SPAWN_OPTS)).rejects.toThrow(UNAVAILABLE_MESSAGE)
    expect(recover).not.toHaveBeenCalled()
  })

  it('never recovers from a toolchain_missing cause', async () => {
    rejectSpawnOnce(mux, relayRejection(cause({ reason: 'toolchain_missing', repairable: false })))
    const recover = vi.fn(async () => provider)
    provider.setTerminalUnavailableRecovery(recover)

    await expect(provider.spawn(SPAWN_OPTS)).rejects.toThrow(UNAVAILABLE_MESSAGE)
    expect(recover).not.toHaveBeenCalled()
  })

  it('ignores a malformed cause rather than half-reading it', async () => {
    rejectSpawnOnce(mux, relayRejection({ status: 'blocked', repairable: true }))
    const recover = vi.fn(async () => provider)
    provider.setTerminalUnavailableRecovery(recover)

    await expect(provider.spawn(SPAWN_OPTS)).rejects.toThrow(UNAVAILABLE_MESSAGE)
    expect(recover).not.toHaveBeenCalled()
  })

  it('leaves an old relay that publishes no cause on today behaviour', async () => {
    rejectSpawnOnce(mux, new Error(UNAVAILABLE_MESSAGE))
    const recover = vi.fn(async () => provider)
    provider.setTerminalUnavailableRecovery(recover)

    await expect(provider.spawn(SPAWN_OPTS)).rejects.toThrow(UNAVAILABLE_MESSAGE)
    expect(recover).not.toHaveBeenCalled()
  })

  it('does not swallow an ordinary spawn failure', async () => {
    rejectSpawnOnce(mux, new Error('shell not found'))
    const recover = vi.fn(async () => provider)
    provider.setTerminalUnavailableRecovery(recover)

    await expect(provider.spawn(SPAWN_OPTS)).rejects.toThrow('shell not found')
    expect(recover).not.toHaveBeenCalled()
  })
})
