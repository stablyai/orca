import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatTerminalFileAttachments } from './use-mobile-native-chat-terminal-file-attachments'
import {
  closeMobileNativeChatEditInputs,
  readMobileNativeChatDraftInputs,
  resetMobileNativeChatDraftInputsForTests
} from './mobile-native-chat-draft-inputs'
import {
  resetMobileNativeChatDraftStoreForTests,
  setMobileNativeChatDraftText,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'
import type { PickedMobileFile } from '../../../platform/media-picker-contract'
import type { RpcClient } from '../../../transport/rpc-client'
import type { RpcResponse } from '../../../transport/types'

const picker = vi.hoisted(() => ({ pickFiles: vi.fn() }))
vi.mock('../../../platform/media-picker', () => ({ useMediaPicker: () => picker }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

const SCOPE = 'host\0worktree\0tab-a'
const OTHER_SCOPE = 'host\0worktree\0tab-b'

function file(name: string): PickedMobileFile {
  return { name, mime: 'application/pdf', byteLength: 3, base64: 'YWJj' }
}

function reference(name: string): string {
  return `[File from my phone, saved on this computer as \`/tmp/orca-paste-1/${name}\`]`
}

async function* picked(...files: PickedMobileFile[]) {
  yield* files
}

type Request = { method: string; params: unknown }

function hostClient(commit: (method: string, requests: Request[]) => Promise<string> | string) {
  const requests: Request[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the upload path calls only sendRequest, which this fake supplies.
  const client = {
    sendRequest: vi.fn(async (method: string, params: unknown): Promise<RpcResponse> => {
      requests.push({ method, params })
      const result =
        method === 'clipboard.startImageUpload'
          ? { uploadId: `upload-${requests.length}` }
          : method === 'clipboard.commitImageUpload'
            ? await commit(method, requests)
            : { receivedBase64Length: 4 }
      return { id: 'r', ok: true, result, _meta: { runtimeId: 'r' } }
    })
  } as unknown as RpcClient
  return { client, requests }
}

describe('useMobileNativeChatTerminalFileAttachments', () => {
  let renderer: ReactTestRenderer | null = null
  let attach: () => Promise<void> = async () => {}
  const drafts = { asking: '', other: '' }
  const showToast = vi.fn()

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    showToast.mockClear()
    picker.pickFiles.mockReset()
    resetMobileNativeChatDraftInputsForTests()
    resetMobileNativeChatDraftStoreForTests()
  })

  function Harness(props: {
    client: RpcClient
    scopeKey: string
    enabled?: boolean
  }): React.JSX.Element | null {
    attach = useMobileNativeChatTerminalFileAttachments({
      enabled: true,
      getConnectionId: async () => null,
      showToast,
      ...props
    })
    drafts.asking = useMobileNativeChatDraft(SCOPE)
    drafts.other = useMobileNativeChatDraft(OTHER_SCOPE)
    return null
  }

  async function mount(client: RpcClient, enabled = true): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { client, scopeKey: SCOPE, enabled }))
    })
  }

  it('uploads a file under its own name and references it at the end of the draft', async () => {
    const { client, requests } = hostClient(() => '/tmp/orca-paste-1/spec.pdf')
    picker.pickFiles.mockReturnValue(picked(file('spec.pdf')))
    setMobileNativeChatDraftText(SCOPE, 'Summarize')
    await mount(client)

    await act(() => attach())

    expect(requests[0]).toMatchObject({
      method: 'clipboard.startImageUpload',
      params: { fileName: 'spec.pdf' }
    })
    expect(drafts.asking).toBe(`Summarize ${reference('spec.pdf')} `)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('holds Send until the upload lands in the draft', async () => {
    let finishCommit = (_path: string) => {}
    const { client } = hostClient(
      () =>
        new Promise<string>((resolve) => {
          finishCommit = resolve
        })
    )
    picker.pickFiles.mockReturnValue(picked(file('spec.pdf')))
    await mount(client)

    const attaching = attach()
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(3))
    expect(readMobileNativeChatDraftInputs(SCOPE).pending).toBe(1)

    finishCommit('/tmp/orca-paste-1/spec.pdf')
    await act(() => attaching)
    expect(readMobileNativeChatDraftInputs(SCOPE).pending).toBe(0)
  })

  it('leaves the reference in the chat that asked after a tab switch', async () => {
    let finishCommit = (_path: string) => {}
    const { client } = hostClient(
      () =>
        new Promise<string>((resolve) => {
          finishCommit = resolve
        })
    )
    picker.pickFiles.mockReturnValue(picked(file('spec.pdf')))
    await mount(client)

    const attaching = attach()
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(3))
    await act(async () => {
      renderer!.update(createElement(Harness, { client, scopeKey: OTHER_SCOPE }))
    })
    finishCommit('/tmp/orca-paste-1/spec.pdf')
    await act(() => attaching)

    expect(drafts.asking).toBe(`${reference('spec.pdf')} `)
    expect(drafts.other).toBe('')
  })

  it('keeps the earlier file when a later one fails, and names the one that failed', async () => {
    const { client } = hostClient((_method, requests) => {
      const commits = requests.filter(({ method }) => method.endsWith('commitImageUpload'))
      if (commits.length === 2) {
        throw new Error('disk full')
      }
      return '/tmp/orca-paste-1/first.pdf'
    })
    picker.pickFiles.mockReturnValue(picked(file('first.pdf'), file('second.pdf')))
    await mount(client)

    await act(() => attach())

    expect(drafts.asking).toBe(`${reference('first.pdf')} `)
    expect(showToast).toHaveBeenCalledWith("Couldn't upload second.pdf")
  })

  it('refuses a file an older host saved as a pasted image', async () => {
    const { client } = hostClient(() => 'C:\\Temp\\orca-paste-1730-ab12.png')
    picker.pickFiles.mockReturnValue(picked(file('spec.pdf')))
    await mount(client)

    await act(() => attach())

    expect(drafts.asking).toBe('')
    expect(showToast).toHaveBeenCalledWith("Couldn't upload spec.pdf")
  })

  it('publishes nothing after the draft is cancelled', async () => {
    let finishCommit = (_path: string) => {}
    const { client } = hostClient(
      () =>
        new Promise<string>((resolve) => {
          finishCommit = resolve
        })
    )
    picker.pickFiles.mockReturnValue(picked(file('spec.pdf')))
    await mount(client)

    const attaching = attach()
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(3))
    closeMobileNativeChatEditInputs(SCOPE)
    finishCommit('/tmp/orca-paste-1/spec.pdf')
    await act(() => attaching)

    expect(drafts.asking).toBe('')
  })

  it('opens no picker while it cannot upload', async () => {
    const { client } = hostClient(() => '/tmp/orca-paste-1/spec.pdf')
    await mount(client, false)

    await act(() => attach())

    expect(picker.pickFiles).not.toHaveBeenCalled()
  })
})
