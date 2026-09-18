/**
 * The behaviours that only exist while a read is genuinely in flight or genuinely failing: the
 * per-connection cap, an abort that arrives mid-read, and a verify whose open throws. All three go
 * through a gate on `open`, so none of them depends on a race between an event loop and a stopwatch.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../core'
import type { RpcDispatcher } from '../dispatcher'

/** A latch on `open`, so a read can be held mid-flight without racing a stopwatch. */
type OpenGate = {
  blocker: Promise<void> | null
  unlatch: (() => void) | null
  opens: number
  failures: number
  hold(): void
  release(): void
  failNextOpen(): void
  reset(): void
}

const { gate } = vi.hoisted(() => {
  const gate: OpenGate = {
    blocker: null,
    unlatch: null,
    opens: 0,
    failures: 0,
    hold() {
      gate.blocker = new Promise<void>((resolve) => {
        gate.unlatch = resolve
      })
    },
    release() {
      gate.unlatch?.()
      gate.blocker = null
      gate.unlatch = null
    },
    failNextOpen() {
      gate.failures++
    },
    reset() {
      gate.release()
      gate.opens = 0
      gate.failures = 0
    }
  }
  return { gate }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      gate.opens++
      if (gate.blocker) {
        await gate.blocker
      }
      if (gate.failures > 0) {
        gate.failures--
        throw new Error('EIO: i/o error, open')
      }
      return actual.open(...args)
    }
  }
})

import { resetBundledMobileWebBundleCacheForTests } from '../../bundled-mobile-web-bundle'
import { resetMobileWebBundleAssetVerdictsForTests } from './mobile-web-bundle-asset-reader'
import {
  MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS,
  resetMobileWebBundleReadAdmissionForTests
} from './mobile-web-bundle-read-admission'
import {
  installMobileWebBundleAppPath,
  mobileWebBundleDispatcher,
  writeSyntheticMobileWebBundle,
  type SyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'

let scratch: string
let bundle: SyntheticMobileWebBundle
let dispatcher: RpcDispatcher

type DispatchOptions = { connectionId?: string; signal?: AbortSignal }

function chunk(offset: number, options?: DispatchOptions): Promise<RpcResponse> {
  return dispatcher.dispatch(
    {
      id: `chunk-${String(offset)}`,
      authToken: 'tok',
      method: 'mobileWeb.bundle.chunk',
      params: { buildId: bundle.buildId, path: 'index.html', offset }
    },
    options
  )
}

function errorMessage(response: RpcResponse): string | undefined {
  return response.ok ? undefined : response.error.message
}

/** Lets every already-scheduled continuation run, without advancing any clock. */
async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-mobile-web-reads-'))
  installMobileWebBundleAppPath(scratch)
  bundle = writeSyntheticMobileWebBundle(join(scratch, 'out', 'mobile-web'), 7)
  gate.reset()
  resetBundledMobileWebBundleCacheForTests()
  resetMobileWebBundleAssetVerdictsForTests()
  resetMobileWebBundleReadAdmissionForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dispatcher = mobileWebBundleDispatcher()
})

afterEach(() => {
  gate.reset()
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('chunk reads in flight on one connection', () => {
  // Pinned as a literal because every other case here is written in terms of the constant, so the
  // budget itself would otherwise move silently with it.
  it('budgets four', () => {
    expect(MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS).toBe(4)
  })

  it('admits four and refuses the fifth, then admits it once one finishes', async () => {
    gate.hold()
    const inFlight = Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () =>
      chunk(0, { connectionId: 'conn-1' })
    )
    await settleMicrotasks()

    const overflow = await chunk(0, { connectionId: 'conn-1' })
    expect(errorMessage(overflow)).toBe('mobile_web_bundle_read_limited')

    gate.release()
    const admitted = await Promise.all(inFlight)
    expect(admitted.every((response) => response.ok)).toBe(true)

    const afterwards = await chunk(0, { connectionId: 'conn-1' })
    expect(afterwards.ok).toBe(true)
  })

  it('does not let one connection at its cap cost another connection a read', async () => {
    gate.hold()
    const saturating = Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () =>
      chunk(0, { connectionId: 'conn-1' })
    )
    await settleMicrotasks()

    const neighbour = chunk(0, { connectionId: 'conn-2' })
    await settleMicrotasks()
    gate.release()

    expect((await neighbour).ok).toBe(true)
    expect((await Promise.all(saturating)).every((response) => response.ok)).toBe(true)
  })

  it('hashes an asset once even when four first readers arrive together', async () => {
    gate.hold()
    const together = Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () =>
      chunk(0, { connectionId: 'conn-1' })
    )
    await settleMicrotasks()

    // One verification open for the four of them; the rest are the four chunk reads.
    const opensBeforeRelease = gate.opens
    gate.release()
    await Promise.all(together)

    expect(opensBeforeRelease).toBe(1)
    expect(gate.opens).toBe(1 + MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS)
  })
})

describe('a client that disconnects while its chunk is being read', () => {
  it('stops before the chunk read, and answers nothing it had already produced', async () => {
    const controller = new AbortController()
    gate.hold()
    const pending = chunk(0, { connectionId: 'conn-3', signal: controller.signal })
    await settleMicrotasks()
    expect(gate.opens).toBe(1)

    controller.abort()
    gate.release()
    const response = await pending

    expect(response.ok).toBe(false)
    expect(errorMessage(response)).toBe('client_disconnected')
    // The verification open happened before the abort; the chunk read never did.
    expect(gate.opens).toBe(1)
  })

  // Honouring `signal` exists so a client that is gone stops costing file reads. Verification
  // streams the whole asset, up to the contract's 10 MiB ceiling, so the check that matters is the
  // one before it: not a single open.
  it('does not hash the asset at all when the signal was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const response = await chunk(0, { connectionId: 'conn-6', signal: controller.signal })

    expect(errorMessage(response)).toBe('client_disconnected')
    expect(gate.opens).toBe(0)
  })

  it('releases the slot it was holding, so the connection is not permanently capped', async () => {
    const aborted = Array.from({ length: MAX_CONCURRENT_MOBILE_WEB_BUNDLE_READS }, () => {
      const controller = new AbortController()
      return {
        controller,
        response: chunk(0, { connectionId: 'conn-4', signal: controller.signal })
      }
    })
    gate.hold()
    await settleMicrotasks()
    for (const { controller } of aborted) {
      controller.abort()
    }
    gate.release()
    await Promise.all(aborted.map(({ response }) => response))

    expect((await chunk(0, { connectionId: 'conn-4' })).ok).toBe(true)
  })
})

describe('a verify whose read of the asset fails', () => {
  // The verdict cache is never invalidated, so remembering a transient EIO as "these bytes are
  // wrong" would poison the asset until the desktop restarts.
  it('is not remembered as a verdict, so the next read still verifies', async () => {
    gate.failNextOpen()

    const failed = await chunk(0, { connectionId: 'conn-5' })
    const retried = await chunk(0, { connectionId: 'conn-5' })

    expect(errorMessage(failed)).toBe('mobile_web_bundle_asset_changed')
    expect(retried.ok).toBe(true)
  })
})
