/**
 * End-to-end in-process regression test for the remote workspace listing that
 * overflowed the relay's bounded transport.
 *
 * Wires the client-side SshChannelMultiplexer to the relay-side
 * RelayDispatcher + FsHandler through an in-memory pipe (no SSH), exactly like
 * fs-list-files-cancel.integration.test.ts. The scan body is a fake that
 * honours maxResults the way the real fs-handler clamp does, so the test can
 * show both halves of the bug:
 *   - an unbounded fs.listFiles result (100k+ paths on a workspace that vendors
 *     gitignored repo clones) exceeds the 2 MiB producer-queue frame cap, so
 *     the dispatcher substitutes ResponseOverCapacity and the client sees an
 *     error instead of the file list, and
 *   - the same workspace bounded to QUICK_OPEN_LISTING_MAX_RESULTS stays inside
 *     the cap and the list is delivered.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

const { fakeListFiles } = vi.hoisted(() => {
  // Why: 68-char paths make the arithmetic explicit — 20_001 of them serialise
  // to ~1.35 MiB (inside the 2 MiB cap) and 120_000 to ~8.13 MiB (over it).
  const buildPath = (index: number): string =>
    `projects/vendored-clone/packages/app/src/generated/file-${String(index).padStart(9, '0')}.ts`
  const fakeListFiles = Object.assign(
    vi.fn(
      (
        _rootPath: string,
        _excludes: readonly string[] = [],
        options: { signal?: AbortSignal; maxResults?: number } = {}
      ): Promise<string[]> => {
        // Mirror the real scanners: the caller-supplied cap decides how many
        // paths the enumeration returns. Without a cap the whole tree comes
        // back; with one, only that many paths.
        const total = options.maxResults ?? 120_000
        return Promise.resolve(Array.from({ length: total }, (_, index) => buildPath(index)))
      }
    ),
    { buildPath }
  )
  return { fakeListFiles }
})

vi.mock('./fs-handler-utils', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>
  return {
    ...original,
    listFilesWithRg: fakeListFiles
  }
})

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'
import { RelayDispatcher } from './dispatcher'
import { RelayContext } from './context'
import { FsHandler } from './fs-handler'
import { RelayErrorCode } from './protocol'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../shared/quick-open-listing-limits'

async function flushPipe(): Promise<void> {
  // The in-memory pipe defers each hop with setImmediate; a few macrotask
  // turns guarantee request/response frames have crossed both directions.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('Integration: fs.listFiles bounded-transport capacity', () => {
  let mux: SshChannelMultiplexer
  let dispatcher: RelayDispatcher
  let fsHandler: FsHandler

  beforeEach(() => {
    fakeListFiles.mockClear()

    let relayFeedFn: (data: Buffer) => void
    const clientDataCallbacks: ((data: Buffer) => void)[] = []
    const clientTransport: MultiplexerTransport = {
      write: (data: Buffer) => {
        setImmediate(() => relayFeedFn?.(data))
      },
      onData: (cb) => {
        clientDataCallbacks.push(cb)
      },
      onClose: () => {}
    }
    dispatcher = new RelayDispatcher((data: Buffer) => {
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
      })
    })
    relayFeedFn = (data: Buffer) => dispatcher.feed(data)
    fsHandler = new FsHandler(dispatcher, new RelayContext())
    mux = new SshChannelMultiplexer(clientTransport)
  })

  afterEach(() => {
    mux.dispose()
    dispatcher.dispose()
    fsHandler.dispose()
  })

  it('overflows the transport when the listing is unbounded (the bug)', async () => {
    // No maxResults: the whole 120k-path tree is enumerated and the ~8 MiB
    // response cannot fit the relay's 2 MiB producer frame, so the dispatcher
    // replaces the result with a capacity error rather than closing the client.
    const outcome = mux.request('fs.listFiles', { rootPath: '/remote/firstmate' }).then(
      () => ({ ok: true as const }),
      (error: Error & { code?: number }) => ({ ok: false as const, error })
    )
    await flushPipe()

    const result = await outcome
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe('Relay response exceeded the bounded transport capacity')
      expect(result.error.code).toBe(RelayErrorCode.ResponseOverCapacity)
    }
  })

  it('delivers the listing when bounded to QUICK_OPEN_LISTING_MAX_RESULTS (the fix)', async () => {
    // The main-side callers now forward this cap; the relay clamps to it and
    // stops enumerating, so the ~1.35 MiB response fits and crosses the wire.
    const paths = (await mux.request('fs.listFiles', {
      rootPath: '/remote/firstmate',
      maxResults: QUICK_OPEN_LISTING_MAX_RESULTS
    })) as string[]

    expect(paths).toHaveLength(QUICK_OPEN_LISTING_MAX_RESULTS)
    expect(paths[0]).toBe(fakeListFiles.buildPath(0))
    // The cap was honoured end-to-end: the scan received the bounded count.
    expect(fakeListFiles).toHaveBeenCalledWith(
      '/remote/firstmate',
      expect.anything(),
      expect.objectContaining({ maxResults: QUICK_OPEN_LISTING_MAX_RESULTS })
    )
  })
})
