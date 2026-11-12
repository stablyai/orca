import { Buffer } from 'node:buffer'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { stubRpcClient } from '../../../transport/rpc/rpc-client-test-stub'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import type { PickedMobileFile } from '../../../platform/media-picker-contract'
import {
  closeMobileNativeChatEditInputs,
  readMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import { useMobileNativeChatFileAttachments } from './use-mobile-native-chat-file-attachments'

const picked = vi.hoisted((): { files: PickedMobileFile[] } => ({ files: [] }))
vi.mock('../../../platform/media-picker', () => ({
  useMediaPicker: () => ({
    pickFiles: async function* () {
      yield* picked.files
    }
  })
}))

const SCOPE = 'h\0w\0tab-files'
const CHUNK = 393216

function ok(result: unknown): RpcResponse {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

type Hook = ReturnType<typeof useMobileNativeChatFileAttachments>
type Args = Parameters<typeof useMobileNativeChatFileAttachments>[0]

function makeFile(release: Promise<void>): PickedMobileFile {
  return {
    name: 'lenta.mp4',
    mime: 'video/mp4',
    byteLength: CHUNK * 2,
    chunks: async function* () {
      yield Buffer.alloc(CHUNK, 1).toString('base64')
      await release
      yield Buffer.alloc(CHUNK, 2).toString('base64')
    }
  }
}

describe('useMobileNativeChatFileAttachments', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null

  function Harness({ args }: { args: Args }): null {
    hook = useMobileNativeChatFileAttachments(args)
    return null
  }

  beforeEach(() => {
    picked.files = []
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    closeMobileNativeChatEditInputs(SCOPE)
    renderer = null
    hook = null
  })

  function mount(
    client: Pick<RpcClient, 'sendRequest'>,
    showToast = vi.fn(),
    overrides: Partial<Args> = {}
  ): void {
    const args: Args = {
      client: stubRpcClient(client),
      target: { kind: 'terminal', getConnectionId: async () => null },
      scopeKey: SCOPE,
      enabled: true,
      showToast,
      ...overrides
    }
    act(() => {
      renderer = create(createElement(Harness, { args }))
    })
  }

  it('removing an uploading file aborts its transfer', async () => {
    const methods: string[] = []
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async (method: string) => {
        methods.push(method)
        return method === 'terminalFileUpload.start'
          ? ok({ uploadId: 'up-1' })
          : ok({ aborted: true })
      })
    }
    const showToast = vi.fn()
    let release!: () => void
    picked.files = [makeFile(new Promise<void>((resolve) => (release = resolve)))]
    mount(client, showToast)

    let attaching!: Promise<void>
    await act(async () => {
      attaching = hook!.attachFiles()
      for (let i = 0; i < 50 && !methods.includes('terminalFileUpload.append'); i++) {
        await Promise.resolve()
      }
    })
    expect(hook!.files).toMatchObject([{ name: 'lenta.mp4', sentBytes: CHUNK, path: null }])
    expect(readMobileNativeChatDraftInputs(SCOPE).pending).toBe(1)

    await act(async () => {
      hook!.removeFiles([hook!.files[0]!.id])
      release()
      await attaching
    })

    expect(methods).toContain('terminalFileUpload.abort')
    expect(methods).not.toContain('terminalFileUpload.commit')
    expect(hook!.files).toEqual([])
    expect(readMobileNativeChatDraftInputs(SCOPE).pending).toBe(0)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('removing an uploading file from a remounted instance still aborts its transfer', async () => {
    const methods: string[] = []
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async (method: string) => {
        methods.push(method)
        return method === 'terminalFileUpload.start'
          ? ok({ uploadId: 'up-1' })
          : ok({ aborted: true })
      })
    }
    let release!: () => void
    picked.files = [makeFile(new Promise<void>((resolve) => (release = resolve)))]
    mount(client)

    let attaching!: Promise<void>
    await act(async () => {
      attaching = hook!.attachFiles()
      for (let i = 0; i < 50 && !methods.includes('terminalFileUpload.append'); i++) {
        await Promise.resolve()
      }
    })
    act(() => renderer?.unmount())
    mount(client)
    expect(hook!.files).toHaveLength(1)

    await act(async () => {
      hook!.removeFiles([hook!.files[0]!.id])
      release()
      await attaching
    })

    expect(methods).toContain('terminalFileUpload.abort')
    expect(methods).not.toContain('terminalFileUpload.commit')
    expect(hook!.files).toEqual([])
    expect(readMobileNativeChatDraftInputs(SCOPE).pending).toBe(0)
  })

  it('closing the draft mid-transfer aborts the file instead of committing it', async () => {
    const methods: string[] = []
    const client: Pick<RpcClient, 'sendRequest'> = {
      sendRequest: vi.fn(async (method: string) => {
        methods.push(method)
        return method === 'terminalFileUpload.start'
          ? ok({ uploadId: 'up-1' })
          : ok({ aborted: true })
      })
    }
    const showToast = vi.fn()
    let release!: () => void
    picked.files = [makeFile(new Promise<void>((resolve) => (release = resolve)))]
    mount(client, showToast)

    let attaching!: Promise<void>
    await act(async () => {
      attaching = hook!.attachFiles()
      for (let i = 0; i < 50 && !methods.includes('terminalFileUpload.append'); i++) {
        await Promise.resolve()
      }
    })

    await act(async () => {
      closeMobileNativeChatEditInputs(SCOPE)
      release()
      await attaching
    })

    expect(methods).toContain('terminalFileUpload.abort')
    expect(methods).not.toContain('terminalFileUpload.commit')
    expect(showToast).not.toHaveBeenCalled()
  })

  it('offers no pasted-text attachment for a terminal target', () => {
    mount({ sendRequest: vi.fn() })
    expect(hook!.attachPastedText).toBeNull()
  })

  it('reports files can be attached only with a client, a storage target, a scope and the lease', () => {
    mount({ sendRequest: vi.fn() })
    expect(hook!.canAttachFiles).toBe(true)
    act(() => renderer?.unmount())
    mount({ sendRequest: vi.fn() }, vi.fn(), { target: null })
    expect(hook!.canAttachFiles).toBe(false)
    act(() => renderer?.unmount())
    mount({ sendRequest: vi.fn() }, vi.fn(), { enabled: false })
    expect(hook!.canAttachFiles).toBe(false)
  })
})
