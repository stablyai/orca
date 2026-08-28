import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, RelayErrorCode } from './protocol'
import { FileRangeReadRequestError, MAX_FILE_RANGE_READ_BYTES } from '../shared/file-range-read'

/** Minimal dispatcher: this suite only needs the registered request handlers.
 *  The full harness lives in fs-handler.test.ts, which is at its line budget. */
function createHandlerUnderTest() {
  const requests = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const dispatcher = {
    onRequest: (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      requests.set(method, handler)
    },
    onNotification: vi.fn(),
    notify: vi.fn(),
    notifyClient: vi.fn(),
    onClientDetached: vi.fn(() => () => {})
  }
  const handler = new FsHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const registered = requests.get(method)
    if (!registered) {
      throw new Error(`No handler for ${method}`)
    }
    return registered(params)
  }
  return { handler, call }
}

let root: string
let filePath: string
let underTest: ReturnType<typeof createHandlerUnderTest>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-relay-range-dispatch-'))
  filePath = join(root, 'data.jsonl')
  await writeFile(filePath, '0123456789')
  underTest = createHandlerUnderTest()
})

afterEach(async () => {
  underTest.handler.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('fs.readFileRange dispatch', () => {
  it('serves the requested window', async () => {
    const result = (await underTest.call('fs.readFileRange', {
      filePath,
      position: 2,
      length: 3
    })) as { base64: string; bytesRead: number }
    expect(Buffer.from(result.base64, 'base64').toString('utf8')).toBe('234')
    expect(result.bytesRead).toBe(3)
  })

  // Params reach the handler as an unschema-d bag, so a missing or wrong-typed
  // path must be a stated refusal rather than a TypeError from expandTilde.
  it.each([
    ['a missing filePath', {}],
    ['a non-string filePath', { filePath: 42 }],
    ['an empty filePath', { filePath: '' }]
  ])('rejects %s', async (_label, params) => {
    await expect(
      underTest.call('fs.readFileRange', { position: 0, length: 4, ...params })
    ).rejects.toBeInstanceOf(FileRangeReadRequestError)
  })

  it('rejects an out-of-contract offset before touching the file', async () => {
    await expect(
      underTest.call('fs.readFileRange', { filePath, position: -1, length: 4 })
    ).rejects.toBeInstanceOf(FileRangeReadRequestError)
  })
})

// A direct call to readRelayFileRange never meets the writer, which is where an
// over-wide window actually dies: a response frame past the control lane's
// budget is demoted to `legacy-response` and refused as ResponseOverCapacity.
// This drives a full-cap read through the real dispatcher instead.
describe('fs.readFileRange over the real dispatcher', () => {
  function decodePayload(frame: Buffer): Record<string, unknown> {
    const length = frame.readUInt32BE(9)
    return JSON.parse(frame.subarray(13, 13 + length).toString('utf-8'))
  }

  it('delivers a full-cap window as a result, not a capacity error', async () => {
    const contents = Buffer.allocUnsafe(MAX_FILE_RANGE_READ_BYTES)
    for (let i = 0; i < contents.length; i++) {
      contents[i] = (i * 37) % 256
    }
    const capPath = join(root, 'full-cap.bin')
    await writeFile(capPath, contents)

    const frames: Buffer[] = []
    let closes = 0
    const dispatcher = new RelayDispatcher(
      (data: Buffer) => {
        frames.push(Buffer.from(data))
        return true
      },
      {
        writableHighWaterMark: () => 64 * 1024,
        writableLength: () => 0,
        close: () => {
          closes++
        }
      }
    )
    const handler = new FsHandler(dispatcher, new RelayContext())
    try {
      dispatcher.feed(
        encodeJsonRpcFrame(
          {
            jsonrpc: '2.0',
            id: 91,
            method: 'fs.readFileRange',
            params: { filePath: capPath, position: 0, length: MAX_FILE_RANGE_READ_BYTES }
          },
          1,
          0
        )
      )
      await vi.waitFor(() => expect(frames).toHaveLength(1), { timeout: 4_000 })
      const response = decodePayload(frames[0]) as {
        id: number
        error?: { code: number }
        result?: { base64: string; bytesRead: number }
      }
      expect(response.id).toBe(91)
      expect(response.error?.code).not.toBe(RelayErrorCode.ResponseOverCapacity)
      expect(response.error).toBeUndefined()
      expect(response.result?.bytesRead).toBe(MAX_FILE_RANGE_READ_BYTES)
      expect(Buffer.from(response.result?.base64 ?? '', 'base64').equals(contents)).toBe(true)
      expect(closes).toBe(0)
    } finally {
      handler.dispose()
      dispatcher.dispose()
    }
  })
})

describe('fs.getCapabilities', () => {
  // Rule 1 of docs/reference/remote-wire-compatibility.md: the ranged-read flag
  // is additive. Dropping the pre-existing key would strand an older desktop's
  // quick-open probe on a host that still serves it.
  it('advertises ranged reads without dropping the existing capability', async () => {
    await expect(underTest.call('fs.getCapabilities', {})).resolves.toEqual({
      quickOpenSearchVersion: 1,
      rangedReadVersion: 1
    })
  })
})
