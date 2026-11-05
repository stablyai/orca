import { Buffer } from 'buffer/index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

const device = vi.hoisted(
  (): {
    written: number[][]
    deleted: number
    created: { name: string; mime: string | null }[]
  } => ({
    written: [],
    deleted: 0,
    created: []
  })
)

vi.mock('expo-file-system', () => {
  class File {
    uri = 'content://tree/Download/notes.txt'
    write(bytes: Uint8Array, options: { append: boolean }) {
      expect(options).toEqual({ append: true })
      device.written.push([...bytes])
    }
    delete() {
      device.deleted += 1
    }
  }
  class Directory {
    static pickDirectoryAsync = vi.fn()
    createFile(name: string, mime: string | null) {
      device.created.push({ name, mime })
      return new File()
    }
  }
  return { Directory, File }
})
vi.mock('expo-router', () => ({ useFocusEffect: vi.fn(), useNavigation: vi.fn() }))
vi.mock('../transport/host-client-hooks', () => ({ useHostClient: vi.fn() }))

const { Directory } = await import('expo-file-system')
const { createNativeFileSaver } = await import('./native-file-save')

const ok = (result: unknown): RpcResponse => ({
  id: '1',
  ok: true,
  result,
  _meta: { runtimeId: 'host' }
})
const stat = (size: number) => ok({ size, mtime: 1, isDirectory: false })
const chunk = (bytes: number[]) =>
  ok({ contentBase64: Buffer.from(bytes).toString('base64'), bytesRead: bytes.length, eof: true })

function rig(replies: RpcResponse[]) {
  const fake = {
    sendRequest: vi.fn(async () => {
      const reply = replies.shift()
      if (!reply) {
        throw new Error('Unexpected request')
      }
      return reply
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the saver only calls sendRequest on the client.
  const client = fake as unknown as RpcClient
  const folder = new Directory()
  const pick = vi.fn(async () => folder)
  const saver = createNativeFileSaver(
    () => client,
    () => true,
    pick
  )
  return { saver, pick }
}

const save = { action: 'save', worktreeId: 'w', relativePath: 'docs/notes.txt' }

beforeEach(() => {
  device.written = []
  device.deleted = 0
  device.created = []
})

describe('native file save', () => {
  it('writes any file type into the picked folder under its own name', async () => {
    const r = rig([stat(3), chunk([1, 2, 3]), stat(3)])
    expect(await r.saver.serve(save)).toEqual({ saved: true })
    expect(device.created).toEqual([{ name: 'notes.txt', mime: 'application/octet-stream' }])
    expect(device.written).toEqual([[1, 2, 3]])
    expect(device.deleted).toBe(0)
  })

  it('saves an empty file instead of refusing it as unplayable media', async () => {
    const r = rig([stat(0), stat(0)])
    expect(await r.saver.serve(save)).toEqual({ saved: true })
    expect(device.written).toEqual([])
  })

  it('reports a dismissed folder picker as not saved, without downloading', async () => {
    const r = rig([])
    r.pick.mockRejectedValueOnce(new Error('The file picker was cancelled by the user'))
    expect(await r.saver.serve(save)).toEqual({ saved: false })
    expect(device.created).toEqual([])
  })

  it('removes the partial file when the file changes mid-download', async () => {
    const r = rig([stat(3), chunk([1, 2, 3]), stat(4)])
    await expect(r.saver.serve(save)).rejects.toThrow('File changed')
    expect(device.deleted).toBe(1)
  })

  it('rejects params the page could use to save outside a workspace file', async () => {
    const r = rig([])
    await expect(r.saver.serve({ ...save, extra: true })).rejects.toThrow()
    await expect(
      r.saver.serve({ action: 'save', worktreeId: '', relativePath: 'a' })
    ).rejects.toThrow()
  })
})
