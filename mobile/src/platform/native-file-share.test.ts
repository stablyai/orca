import { describe, expect, it, vi } from 'vitest'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import type { RpcResponse } from '../transport/types'
import {
  MOBILE_SHARE_FILE_NAME_MAX_CHARS,
  MOBILE_SHARE_FILE_PREFIX,
  createNativeFileShareServer,
  mobileShareFileName,
  type NativeSharedFile
} from './native-file-share'

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a])

function ok(result: unknown): RpcResponse {
  return { id: 'id', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

// Answer only the two methods the download pipeline reads; anything else means the pipeline changed.
function readClient(bytes: Uint8Array = PDF_BYTES) {
  return {
    sendRequest: vi.fn(async (method: string, params: Record<string, number | string>) => {
      if (method === 'files.stat') {
        return ok({ size: bytes.byteLength, isDirectory: false, mtime: 1 })
      }
      if (method === 'files.readChunk') {
        const offset = Number(params.offset)
        const length = Number(params.length)
        const slice = bytes.slice(offset, offset + length)
        return ok({
          contentBase64: Buffer.from(slice).toString('base64'),
          bytesRead: slice.byteLength,
          eof: offset + slice.byteLength >= bytes.byteLength
        })
      }
      throw new Error(`unexpected method ${method}`)
    })
  }
}

function shareDeps() {
  const written: { name: string; bytes: Uint8Array }[] = []
  const deleted: string[] = []
  const shared: { uri: string; mimeType: string; dialogTitle: string }[] = []
  let shareError: Error | null = null
  return {
    written,
    deleted,
    shared,
    failShareWith(error: Error) {
      shareError = error
    },
    deps: {
      writeCacheFile: (name: string, bytes: Uint8Array): NativeSharedFile => {
        written.push({ name, bytes })
        return { uri: `file:///cache/${name}`, delete: () => deleted.push(name) }
      },
      shareFile: async (
        file: NativeSharedFile,
        options: { mimeType: string; dialogTitle: string }
      ): Promise<void> => {
        if (shareError !== null) {
          throw shareError
        }
        shared.push({ uri: file.uri, ...options })
      }
    }
  }
}

const params = {
  worktreeId: 'worktree-a',
  relativePath: 'docs/Quarterly Report.pdf',
  mimeType: 'application/pdf',
  title: 'Quarterly Report.pdf'
}

describe('mobileShareFileName', () => {
  it('keeps the pdf extension, sanitises the stem and stamps the name for sweeping', () => {
    const name = mobileShareFileName('docs/Quarterly Report.pdf', 1_700_000_000_000)
    expect(name).toBe(`${MOBILE_SHARE_FILE_PREFIX}1700000000000-Quarterly_Report.pdf`)
  })

  it('bounds a long basename inside the filesystem limit', () => {
    const name = mobileShareFileName(`docs/${'a'.repeat(400)}.pdf`, 1_700_000_000_000)
    expect(name.length).toBe(MOBILE_SHARE_FILE_NAME_MAX_CHARS)
    expect(name.endsWith('.pdf')).toBe(true)
  })
})

describe('native file share server', () => {
  it('downloads from the desktop, writes a cache file and hands it to the share sheet', async () => {
    const client = readClient()
    const deps = shareDeps()
    const share = createNativeFileShareServer(deps.deps)

    await expect(share(client, params)).resolves.toEqual({ shared: true })

    expect(client.sendRequest).toHaveBeenCalledWith(
      'files.readChunk',
      expect.objectContaining({ worktree: 'id:worktree-a', relativePath: params.relativePath }),
      expect.anything()
    )
    expect(deps.written).toHaveLength(1)
    expect(deps.written[0]?.bytes).toEqual(PDF_BYTES)
    expect(deps.written[0]?.name.endsWith('Quarterly_Report.pdf')).toBe(true)
    expect(deps.shared).toEqual([
      {
        uri: `file:///cache/${deps.written[0]?.name}`,
        mimeType: 'application/pdf',
        dialogTitle: 'Quarterly Report.pdf'
      }
    ])
  })

  it('keeps the handed-off file until a later share replaces it', async () => {
    const deps = shareDeps()
    const share = createNativeFileShareServer(deps.deps)

    await share(readClient(), params)
    expect(deps.deleted).toEqual([])

    await share(readClient(), params)
    expect(deps.deleted).toEqual([deps.written[0]?.name])
  })

  it('refuses without a desktop connection instead of writing an empty file', async () => {
    const deps = shareDeps()
    const share = createNativeFileShareServer(deps.deps)

    await expect(share(null, params)).rejects.toBeInstanceOf(BridgeNativeVerbRefusedError)
    expect(deps.written).toEqual([])
  })

  it('deletes the cache file when the device has no viewer to hand it to', async () => {
    const deps = shareDeps()
    deps.failShareWith(new Error('no viewer'))
    const share = createNativeFileShareServer(deps.deps)

    await expect(share(readClient(), params)).rejects.toBeInstanceOf(BridgeNativeVerbRefusedError)
    expect(deps.deleted).toEqual([deps.written[0]?.name])
  })

  it('surfaces an oversized file as a failed hand-off without writing anything', async () => {
    const deps = shareDeps()
    const share = createNativeFileShareServer(deps.deps)
    const client = {
      sendRequest: vi.fn(async () => ok({ size: 300 * 1024 * 1024, isDirectory: false, mtime: 1 }))
    }

    await expect(share(client, params)).rejects.toBeInstanceOf(BridgeNativeVerbRefusedError)
    expect(deps.written).toEqual([])
  })
})
