import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { killPtyFromRuntimeController, stopAndWaitPtyFromRuntimeController } from './kill'
import type * as PtyLiveness from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'

type PtyLivenessModule = typeof PtyLiveness

const provider = {} as IPtyProvider

vi.mock('../provider/registry', () => ({
  getProvider: vi.fn(() => provider),
  getProviderForPty: vi.fn(() => provider),
  getRelayPtyId: (connectionId: string | null | undefined, ptyId: string) =>
    connectionId ? `${connectionId}:${ptyId}` : ptyId
}))

vi.mock('../provider/liveness', async (importOriginal) => ({
  ...(await importOriginal<PtyLivenessModule>()),
  verifyPtyStopped: vi.fn(async () => true)
}))

const PTY_ID = 'pty-fenced'
const EXPECTED = 'pty-fenced:incarnation-1'
const REPLACEMENT = 'pty-fenced:incarnation-2'

function makeDeps(overrides: {
  shutdownProviderAndDetectExit: PtyRuntimeControllerDeps['shutdownProviderAndDetectExit']
  store?: PtyRuntimeControllerDeps['store']
}) {
  const runtime = {
    markPtyStopRequested: vi.fn(),
    markPtyLivenessUnverifiable: vi.fn(),
    markPtyLivenessLive: vi.fn(),
    onPtyExit: vi.fn()
  }
  const finishPtyShutdown = vi.fn(() => EXPECTED)
  const sendPtyExitToRenderer = vi.fn()
  const rememberSyntheticKillExit = vi.fn()
  const deps = {
    runtime,
    store: overrides.store,
    getLocalPtyProviderStartupPromise: () => undefined,
    shutdownProviderAndDetectExit: vi.fn(overrides.shutdownProviderAndDetectExit),
    rememberSyntheticKillExit,
    sendPtyExitToRenderer,
    finishPtyShutdown,
    retiredRejectedPtyIds: new Map(),
    reversibleStopOwnersByPtyId: new Map()
  } as unknown as PtyRuntimeControllerDeps
  return { deps, runtime, finishPtyShutdown, sendPtyExitToRenderer, rememberSyntheticKillExit }
}

/** Resolves the teardown await only after the caller has swapped in a replacement incarnation. */
function replaceIncarnationDuring<T>(outcome: () => Promise<T>): () => Promise<T> {
  return async () => {
    ptyIncarnationById.set(PTY_ID, REPLACEMENT)
    return outcome()
  }
}

afterEach(() => {
  ptyIncarnationById.delete(PTY_ID)
  ptyOwnership.delete(PTY_ID)
  vi.clearAllMocks()
})

describe('runtime controller kill fences the incarnation through asynchronous teardown', () => {
  it.each([
    {
      name: 'a provider shutdown that observed no exit',
      outcome: async () => false
    },
    {
      name: 'a provider shutdown that reports the PTY already gone',
      outcome: async () => {
        throw new Error('Session not found')
      }
    }
  ])('retains a replacement that appeared during $name', async ({ outcome }) => {
    ptyIncarnationById.set(PTY_ID, EXPECTED)
    ptyOwnership.set(PTY_ID, null)
    const { deps, runtime, finishPtyShutdown, sendPtyExitToRenderer } = makeDeps({
      shutdownProviderAndDetectExit: replaceIncarnationDuring(outcome) as never
    })

    expect(killPtyFromRuntimeController(deps, PTY_ID, { expectedIncarnationId: EXPECTED })).toBe(
      true
    )
    await vi.waitFor(() => expect(deps.shutdownProviderAndDetectExit).toHaveBeenCalled())
    // A macrotask turn drains the whole `.then`/`.catch` continuation chain the kill left running.
    await new Promise((resolve) => setImmediate(resolve))

    expect(finishPtyShutdown).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(sendPtyExitToRenderer).not.toHaveBeenCalled()
    expect(ptyIncarnationById.get(PTY_ID)).toBe(REPLACEMENT)
  })

  it('still settles the expected incarnation when no replacement appeared', async () => {
    ptyIncarnationById.set(PTY_ID, EXPECTED)
    ptyOwnership.set(PTY_ID, null)
    const { deps, runtime, finishPtyShutdown, sendPtyExitToRenderer } = makeDeps({
      shutdownProviderAndDetectExit: (async () => false) as never
    })

    expect(killPtyFromRuntimeController(deps, PTY_ID, { expectedIncarnationId: EXPECTED })).toBe(
      true
    )
    await vi.waitFor(() => expect(runtime.onPtyExit).toHaveBeenCalledWith(PTY_ID, -1, EXPECTED))

    expect(finishPtyShutdown).toHaveBeenCalledWith(PTY_ID, undefined, undefined)
    expect(sendPtyExitToRenderer).toHaveBeenCalledWith({
      id: PTY_ID,
      code: -1,
      incarnationId: EXPECTED
    })
  })

  it('aims a failed remote stop at the expected incarnation, never at the replacement', async () => {
    ptyIncarnationById.set(PTY_ID, EXPECTED)
    ptyOwnership.set(PTY_ID, 'conn-1')
    const recordSshRemotePtyKillIntent = vi.fn()
    const { deps, runtime } = makeDeps({
      store: { recordSshRemotePtyKillIntent } as never,
      shutdownProviderAndDetectExit: replaceIncarnationDuring(async () => {
        throw new Error('relay rpc failed')
      }) as never
    })

    killPtyFromRuntimeController(deps, PTY_ID, { expectedIncarnationId: EXPECTED })
    await vi.waitFor(() => expect(recordSshRemotePtyKillIntent).toHaveBeenCalled())

    expect(recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
      'conn-1',
      'conn-1:pty-fenced',
      expect.objectContaining({ incarnationId: EXPECTED })
    )
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })
})

describe('runtime controller stopAndWait fences the incarnation through asynchronous teardown', () => {
  it('refuses to finalize a replacement that appeared during the provider shutdown', async () => {
    ptyIncarnationById.set(PTY_ID, EXPECTED)
    ptyOwnership.set(PTY_ID, null)
    const { deps, runtime, finishPtyShutdown, sendPtyExitToRenderer } = makeDeps({
      shutdownProviderAndDetectExit: replaceIncarnationDuring(async () => false) as never
    })

    await expect(
      stopAndWaitPtyFromRuntimeController(deps, PTY_ID, { expectedIncarnationId: EXPECTED })
    ).resolves.toBe(false)

    expect(finishPtyShutdown).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(sendPtyExitToRenderer).not.toHaveBeenCalled()
    expect(ptyIncarnationById.get(PTY_ID)).toBe(REPLACEMENT)
  })

  it('settles the expected incarnation when it still owns the PTY id', async () => {
    ptyIncarnationById.set(PTY_ID, EXPECTED)
    ptyOwnership.set(PTY_ID, null)
    const { deps, runtime, finishPtyShutdown } = makeDeps({
      shutdownProviderAndDetectExit: (async () => false) as never
    })

    await expect(
      stopAndWaitPtyFromRuntimeController(deps, PTY_ID, { expectedIncarnationId: EXPECTED })
    ).resolves.toBe(true)

    expect(finishPtyShutdown).toHaveBeenCalledWith(PTY_ID, undefined, undefined)
    expect(runtime.onPtyExit).toHaveBeenCalledWith(PTY_ID, 0, EXPECTED)
  })
})
