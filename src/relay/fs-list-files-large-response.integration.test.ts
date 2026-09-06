/**
 * #12547: a full `fs.listFiles` reply for a real monorepo does not fit the relay's control lane.
 *
 * Orca's own checkout is ~22.6k tracked paths averaging 58 characters, so a 20,001-row page
 * serializes to ~1.2MB — past `DISPATCHER_CONTROL_QUEUE_MAX_BYTES`, which demotes it to the
 * `legacy-response` lane where an unrelated producer backlog can refuse it. Refusing at a fixed row
 * or byte ceiling only moves where that shows up; streaming removes it, so these run the real
 * dispatcher, the real FsHandler and the real client multiplexer over an in-memory pipe and assert
 * an over-budget listing arrives intact — in both wire directions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runListFilesScanMock } = vi.hoisted(() => ({ runListFilesScanMock: vi.fn() }))

vi.mock('./fs-list-files-fallback-chain', () => ({ runListFilesScan: runListFilesScanMock }))
vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'
import { requestGitStreamable } from '../main/ssh/ssh-git-response-stream-reader'
import { RelayContext } from './context'
import { RelayDispatcher } from './dispatcher'
import { DISPATCHER_CONTROL_QUEUE_MAX_BYTES } from './dispatcher-writer-admission'
import { FsHandler } from './fs-handler'
import { GitHandler } from './git-handler'
import { GitResponseStreamRegistry } from './git-response-stream'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../shared/quick-open-listing-limits'

/** Shaped like this repository: `packages/<name>/src/...`, ~58 characters. */
function monorepoPaths(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `packages/pkg-${String(index % 64).padStart(2, '0')}/src/renderer/components/entry-${String(index).padStart(6, '0')}.tsx`
  )
}

describe('Integration: an over-budget fs.listFiles reply (#12547)', () => {
  let mux: SshChannelMultiplexer
  let dispatcher: RelayDispatcher
  let fsHandler: FsHandler
  let gitHandler: GitHandler
  let writtenFrames: number[]

  beforeEach(() => {
    runListFilesScanMock.mockReset()
    writtenFrames = []

    let relayFeed: (data: Buffer) => void
    const clientDataCallbacks: ((data: Buffer) => void)[] = []
    const clientTransport: MultiplexerTransport = {
      write: (data: Buffer) => {
        setImmediate(() => relayFeed?.(data))
      },
      onData: (cb) => {
        clientDataCallbacks.push(cb)
      },
      onClose: () => {}
    }
    dispatcher = new RelayDispatcher((data: Buffer) => {
      writtenFrames.push(data.length)
      setImmediate(() => {
        for (const cb of clientDataCallbacks) {
          cb(data)
        }
      })
      return true
    })
    relayFeed = (data: Buffer) => dispatcher.feed(data)
    // Why: the same single registry production wires, so `git.responseAck` — registered by
    // GitHandler — credits the pump an fs.listFiles stream parks on.
    const responseStreams = new GitResponseStreamRegistry()
    const context = new RelayContext()
    fsHandler = new FsHandler(dispatcher, context, undefined, responseStreams)
    gitHandler = new GitHandler(dispatcher, context, undefined, responseStreams)
    mux = new SshChannelMultiplexer(clientTransport)
  })

  afterEach(() => {
    mux.dispose()
    dispatcher.dispose()
    fsHandler.dispose()
    gitHandler.dispose()
  })

  it('delivers a page too large for the control lane, in chunks no frame has to carry', async () => {
    const files = monorepoPaths(QUICK_OPEN_LISTING_MAX_RESULTS)
    // Precondition, measured from the payload rather than asserted between two constants: this is
    // the listing that does not fit, which is what makes the rest of the test mean anything.
    expect(Buffer.byteLength(JSON.stringify(files), 'utf8')).toBeGreaterThan(
      DISPATCHER_CONTROL_QUEUE_MAX_BYTES
    )
    runListFilesScanMock.mockResolvedValue(files)

    const received = await requestGitStreamable(mux, 'fs.listFiles', {
      rootPath: '/remote/root',
      maxResults: QUICK_OPEN_LISTING_MAX_RESULTS
    })

    expect(received).toEqual(files)
    expect(Math.max(...writtenFrames)).toBeLessThan(DISPATCHER_CONTROL_QUEUE_MAX_BYTES)
  })

  it('still answers a client that never opts into streaming, with the whole array', async () => {
    const files = monorepoPaths(QUICK_OPEN_LISTING_MAX_RESULTS)
    runListFilesScanMock.mockResolvedValue(files)

    // Why: an old client sends neither `__streamResponse` nor `maxResults`. It gets one plain frame
    // on the legacy-response lane, as it did before this call ever learned to stream.
    const received = await mux.request('fs.listFiles', { rootPath: '/remote/root' })

    expect(received).toEqual(files)
    expect(Math.max(...writtenFrames)).toBeGreaterThan(DISPATCHER_CONTROL_QUEUE_MAX_BYTES)
  })

  it('leaves a reply that fits on the plain response path', async () => {
    const files = monorepoPaths(100)
    runListFilesScanMock.mockResolvedValue(files)

    const received = await requestGitStreamable(mux, 'fs.listFiles', {
      rootPath: '/remote/root',
      maxResults: 100
    })

    expect(received).toEqual(files)
    expect(Math.max(...writtenFrames)).toBeLessThan(DISPATCHER_CONTROL_QUEUE_MAX_BYTES)
  })
})
