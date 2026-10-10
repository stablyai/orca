/**
 * Ratchet (#18419): `pty.inspectProcess` must NOT be in-flight coalesced the way the sibling git
 * reads in `SshGitReadProvider` are. The host mints one `observationEpoch` per request and the
 * pane foreground reader commits that epoch per read, so a shared reply reads as a stale replay to
 * the second reader to settle — see the companion renderer proof in
 * `src/renderer/src/components/terminal-pane/pane-foreground-inspect-observation-identity.test.ts`.
 * These are request counters, not timings.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSshPtyProviderRpcOperations } from './ssh-pty-provider-rpc-operations'

const RELAY_PTY_ID = 'pty-1'
const APP_PTY_ID = `ssh:conn-1@@${RELAY_PTY_ID}`
const INCARNATION_ID = 'inc-1'

/** Answers `pty.inspectProcess` with a fresh host observation per request, held open on demand. */
function createInspectingOperations(): {
  operations: ReturnType<typeof createSshPtyProviderRpcOperations>
  request: ReturnType<typeof vi.fn>
  resolvers: ((value: unknown) => void)[]
} {
  const resolvers: ((value: unknown) => void)[] = []
  const request = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)))
  return {
    operations: createSshPtyProviderRpcOperations({
      mux: { request } as never,
      toRelayPtyId: () => RELAY_PTY_ID
    }),
    request,
    resolvers
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('SSH pty.inspectProcess observation identity', () => {
  it('gives each overlapping probe of one pane+incarnation its own host observation', async () => {
    const { operations, request, resolvers } = createInspectingOperations()

    const first = operations.inspectProcess(APP_PTY_ID, { expectedIncarnationId: INCARNATION_ID })
    const second = operations.inspectProcess(APP_PTY_ID, { expectedIncarnationId: INCARNATION_ID })
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
    resolvers[0]({ foregroundProcess: 'claude', observationEpoch: 1 })
    resolvers[1]({ foregroundProcess: 'claude', observationEpoch: 2 })
    // Each read settles on the observation minted for it, never a neighbour's.
    expect(await first).toMatchObject({ observationEpoch: 1 })
    expect(await second).toMatchObject({ observationEpoch: 2 })
  })

  it('does not share a failed probe with an overlapping one', async () => {
    const { operations, request, resolvers } = createInspectingOperations()

    const failing = operations.inspectProcess(APP_PTY_ID, { expectedIncarnationId: INCARNATION_ID })
    const overlapping = operations.inspectProcess(APP_PTY_ID, {
      expectedIncarnationId: INCARNATION_ID
    })
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
    resolvers[0](Promise.reject(new Error('relay dropped the probe')))
    resolvers[1]({ foregroundProcess: 'claude', observationEpoch: 1 })

    await expect(failing).rejects.toThrow('relay dropped the probe')
    expect(await overlapping).toMatchObject({ observationEpoch: 1 })
  })
})
