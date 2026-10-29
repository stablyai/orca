import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const device = vi.hoisted(
  (): {
    focused: boolean
    platform: 'ios' | 'android'
    blur: () => void
    focus: () => void
    client: RpcClient | null
    files: Map<string, Uint8Array>
    presentations: string[]
    creates: number
  } => ({
    focused: true,
    platform: 'ios',
    blur: () => {},
    focus: () => {},
    client: null,
    files: new Map(),
    presentations: [],
    creates: 0
  })
)

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return device.platform
    }
  }
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  const navigation = { isFocused: () => device.focused }
  return {
    useNavigation: () => navigation,
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffect(() => {
        let cleanup = device.focused ? effect() : undefined
        device.blur = () => {
          device.focused = false
          cleanup?.()
          cleanup = undefined
        }
        device.focus = () => {
          device.focused = true
          cleanup = effect()
        }
        return () => cleanup?.()
      }, [effect])
  }
})
vi.mock('expo-file-system', () => {
  class Directory {
    readonly uri: string
    constructor(parent: string | Directory, name?: string) {
      this.uri = `${typeof parent === 'string' ? parent : parent.uri}${name ? `/${name}` : ''}`
    }
    get exists() {
      return [...device.files.keys()].some((uri) => uri.startsWith(`${this.uri}/`))
    }
    create(): void {}
    delete(): void {
      for (const uri of device.files.keys()) {
        if (uri.startsWith(`${this.uri}/`)) {
          device.files.delete(uri)
        }
      }
    }
  }
  class File {
    readonly uri: string
    constructor(parent: string | Directory, name?: string) {
      this.uri = `${typeof parent === 'string' ? parent : parent.uri}${name ? `/${name}` : ''}`
    }
    get contentUri() {
      return `content://pdf/${encodeURIComponent(this.uri)}`
    }
    create(): void {
      device.creates += 1
      device.files.set(this.uri, new Uint8Array())
    }
    delete(): void {
      device.files.delete(this.uri)
    }
    open() {
      return {
        writeBytes: (bytes: Uint8Array) => device.files.set(this.uri, Uint8Array.from(bytes)),
        close: () => {}
      }
    }
  }
  return { Directory, File, Paths: { cache: 'file:///cache' } }
})
vi.mock('expo-clipboard', () => ({}))
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-image-picker', () => ({}))
vi.mock('../../modules/orca-mobile-web-shell/src', () => ({
  presentPdf: async (uri: string) => {
    device.presentations.push(uri)
  }
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: device.client })
}))

import { createElement } from 'react'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { useNativePdfViewer } from './native-pdf-view'

let tree: ReactTestRenderer | null = null
let serve: ((params: unknown) => Promise<unknown>) | null = null
const open = { action: 'open', worktreeId: 'folder-workspace', relativePath: 'docs/guide.pdf' }

beforeEach(() => {
  device.focused = true
  device.platform = 'ios'
  device.files.clear()
  device.presentations = []
  device.creates = 0
  serve = null
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

async function mount() {
  const client = createFakeRpcClient()
  const send = vi
    .spyOn(client, 'sendRequest')
    .mockImplementation(async (method) =>
      rpcSuccess(
        'pdf',
        method === 'files.stat'
          ? { size: 4, isDirectory: false, mtime: 1 }
          : { contentBase64: 'JVBERg==', bytesRead: 4, eof: true }
      )
    )
  device.client = client
  function Probe() {
    serve = useNativePdfViewer('host-one', 'page-one')
    return null
  }
  await act(async () => {
    tree = create(createElement(Probe))
  })
  if (serve === null) {
    throw new Error('PDF handler did not mount')
  }
  return { serve, send }
}

it('refuses a PDF open from a retained hidden page before downloading', async () => {
  const handler = await mount()
  act(() => device.blur())
  await expect(handler.serve(open)).rejects.toThrow('not focused')
  expect.soft(handler.send).not.toHaveBeenCalled()
  expect.soft(device.creates).toBe(0)
  expect(device.presentations).toEqual([])
})

it.each(['ios', 'android'] as const)(
  'still downloads and presents after refocus on %s',
  async (platform) => {
    device.platform = platform
    const handler = await mount()
    act(() => device.blur())
    act(() => device.focus())
    await handler.serve(open)
    expect(handler.send.mock.calls.map(([method]) => method)).toEqual([
      'files.stat',
      'files.readChunk',
      'files.stat'
    ])
    expect(device.presentations).toHaveLength(1)
    expect(device.presentations[0]).toMatch(platform === 'android' ? /^content:/ : /^file:/)
    expect([...device.files.values()]).toEqual([new Uint8Array([37, 80, 68, 70])])
  }
)

it('cancels an admitted range on blur without presenting its late bytes', async () => {
  const handler = await mount()
  let finishRange: (reply: ReturnType<typeof rpcSuccess>) => void = () => {}
  handler.send.mockImplementationOnce(async () =>
    rpcSuccess('stat', { size: 4, isDirectory: false, mtime: 1 })
  )
  handler.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRange = resolve
      })
  )
  const pending = handler.serve(open).then(
    () => 'presented',
    () => 'cancelled'
  )
  await vi.waitFor(() => expect(handler.send).toHaveBeenCalledTimes(2))
  act(() => device.blur())
  finishRange(rpcSuccess('range', { contentBase64: 'JVBERg==', bytesRead: 4, eof: true }))
  expect(await pending).toBe('cancelled')
  expect(handler.send).toHaveBeenCalledTimes(2)
  expect(device.presentations).toEqual([])
  expect(device.files.size).toBe(0)
})

it('keeps the last presented PDF intact when its retained page attempts another open while hidden', async () => {
  const handler = await mount()
  await handler.serve(open)
  const presented = [...device.presentations]
  const files = [...device.files.keys()]
  act(() => device.blur())
  await handler.serve({ ...open, relativePath: 'docs/another.pdf' }).catch(() => undefined)
  expect(device.presentations).toEqual(presented)
  expect([...device.files.keys()]).toEqual(files)
  expect(handler.send).toHaveBeenCalledTimes(3)
})
