import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { MARKDOWN_NOTE_NEEDS_HOST_UPDATE_MESSAGE } from './markdown-note-host-editor-tabs'
import { useMobileSessionContentCreateActions } from './use-mobile-session-content-create-actions'

type Scope = Parameters<typeof useMobileSessionContentCreateActions>[0]
type Actions = ReturnType<typeof useMobileSessionContentCreateActions>
type Reply = RpcResponse | Error

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function failure(code: string, message: string): RpcResponse {
  return { id: 'rpc-1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function status(extra: Record<string, unknown>, capabilities: string[] = []): RpcResponse {
  return success({
    capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY, ...capabilities],
    ...extra
  })
}

const NO_RENDERER = failure('runtime_error', 'renderer_unavailable')

/** Answers each method from its own queue, so a test names only the replies it cares about. */
function hostClient(replies: { status: Reply[]; open?: Reply[] }) {
  const queues: Record<string, Reply[]> = {
    'status.get': replies.status,
    'worktree.show': [],
    'files.createFile': [],
    'files.open': replies.open ?? []
  }
  const defaults: Record<string, RpcResponse> = {
    'worktree.show': success({ worktree: { hostId: 'local' } }),
    'files.createFile': success({ created: true }),
    'files.open': success({ opened: true })
  }
  const sendRequest = vi.fn(async (method: string) => {
    const reply = queues[method]?.shift() ?? defaults[method]
    if (!reply) {
      throw new Error(`unexpected ${method}`)
    }
    if (reply instanceof Error) {
      throw reply
    }
    return reply
  })
  const methods = () => sendRequest.mock.calls.map(([method]) => method)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the note flow only sends requests through this client.
  return { client: { sendRequest } as unknown as RpcClient, methods }
}

describe('Markdown Note on a host that may not open editor tabs', () => {
  let renderer: ReactTestRenderer | null = null
  let actions: Actions | null = null

  function mount(client: RpcClient) {
    const showToast = vi.fn()
    const push = vi.fn()
    const scheduleDelayedAction = vi.fn()
    const setCreateError = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the note flow reads only these members of the session scope.
    const scope = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      worktreeName: 'feature',
      router: { push },
      client,
      creatingMarkdown: false,
      setCreatingMarkdown: vi.fn(),
      setCreateError,
      scheduleDelayedAction,
      showToast,
      fetchSessionTabs: vi.fn(async () => {}),
      handleCreateBrowserRef: { current: null }
    } as unknown as Scope
    function Probe() {
      actions = useMobileSessionContentCreateActions(scope)
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    return { showToast, push, scheduleDelayedAction, setCreateError }
  }

  async function tapMarkdownNote(): Promise<void> {
    await act(async () => {
      await actions?.handleCreateMarkdownNote()
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    actions = null
  })

  it.each(['openable', 'initializing', 'blocked'])(
    'creates nothing and says to update when an older host reports its window %s',
    async (desktopWindowStatus) => {
      const host = hostClient({ status: [status({ desktopWindowStatus })] })
      const ui = mount(host.client)

      await tapMarkdownNote()

      expect(host.methods()).toEqual(['status.get'])
      expect(ui.showToast).toHaveBeenCalledTimes(1)
      expect(ui.showToast).toHaveBeenCalledWith(MARKDOWN_NOTE_NEEDS_HOST_UPDATE_MESSAGE, 1800)
      expect(ui.setCreateError).not.toHaveBeenCalledWith(MARKDOWN_NOTE_NEEDS_HOST_UPDATE_MESSAGE)
      expect(ui.push).not.toHaveBeenCalled()
    }
  )

  it('creates and opens the note when the host advertises editor tabs, whatever its window', async () => {
    const host = hostClient({
      status: [
        status({ desktopWindowStatus: 'openable' }, [
          SESSION_TABS_HOST_EDITOR_TABS_RUNTIME_CAPABILITY
        ])
      ]
    })
    const ui = mount(host.client)

    await tapMarkdownNote()

    expect(host.methods()).toEqual([
      'status.get',
      'worktree.show',
      'files.createFile',
      'files.open'
    ])
    expect(ui.showToast).not.toHaveBeenCalled()
    expect(ui.scheduleDelayedAction).toHaveBeenCalledTimes(1)
  })

  it('creates and opens the note when an older host has its window available', async () => {
    const host = hostClient({ status: [status({ desktopWindowStatus: 'available' })] })
    const ui = mount(host.client)

    await tapMarkdownNote()

    expect(host.methods()).toEqual([
      'status.get',
      'worktree.show',
      'files.createFile',
      'files.open'
    ])
    expect(ui.showToast).not.toHaveBeenCalled()
  })

  it.each([
    ['absent', {}],
    ['a future value', { desktopWindowStatus: 'detached' }],
    ['malformed', { desktopWindowStatus: 7 }],
    ['null', { desktopWindowStatus: null }]
  ])('still attempts the note when the window status is %s', async (_name, extra) => {
    const host = hostClient({ status: [status(extra)] })
    const ui = mount(host.client)

    await tapMarkdownNote()

    expect(host.methods()).toEqual([
      'status.get',
      'worktree.show',
      'files.createFile',
      'files.open'
    ])
    expect(ui.showToast).not.toHaveBeenCalled()
  })

  it('previews the created note on the device when an unknown host then refuses the tab', async () => {
    const host = hostClient({ status: [status({})], open: [NO_RENDERER] })
    const ui = mount(host.client)

    await tapMarkdownNote()

    expect(host.methods()).toEqual([
      'status.get',
      'worktree.show',
      'files.createFile',
      'files.open'
    ])
    expect(ui.push).toHaveBeenCalledTimes(1)
    expect(ui.push).toHaveBeenCalledWith({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'worktree',
        relativePath: 'untitled.md',
        name: 'untitled.md',
        worktreeName: 'feature'
      }
    })
    expect(ui.showToast).not.toHaveBeenCalled()
    expect(ui.setCreateError).not.toHaveBeenCalledWith(expect.stringContaining('renderer'))
  })

  it.each([
    [
      'a retryable refusal',
      failure('runtime_error', "The computer's Orca window is still starting. Try again.")
    ],
    ['a lost connection', new Error('socket closed')]
  ])(
    'previews the created note and says once why it is not a tab after %s',
    async (_name, reply) => {
      const host = hostClient({ status: [status({})], open: [reply] })
      const ui = mount(host.client)

      await tapMarkdownNote()

      expect(ui.push).toHaveBeenCalledTimes(1)
      expect(ui.push).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ relativePath: 'untitled.md' })
        })
      )
      expect(ui.showToast).toHaveBeenCalledTimes(1)
      expect(ui.showToast).toHaveBeenCalledWith(
        "Opened untitled.md on this phone. Orca on the computer couldn't open it as a tab.",
        2400
      )
      expect(ui.setCreateError).not.toHaveBeenCalledWith(expect.stringMatching(/\S/))
    }
  )

  it('asks the host again on every tap: a window reopened on the same connection is used', async () => {
    const host = hostClient({
      status: [
        status({ desktopWindowStatus: 'openable' }),
        status({ desktopWindowStatus: 'available' })
      ]
    })
    const ui = mount(host.client)

    await tapMarkdownNote()
    expect(host.methods()).toEqual(['status.get'])
    expect(ui.showToast).toHaveBeenCalledWith(MARKDOWN_NOTE_NEEDS_HOST_UPDATE_MESSAGE, 1800)

    await tapMarkdownNote()
    expect(host.methods()).toEqual([
      'status.get',
      'status.get',
      'worktree.show',
      'files.createFile',
      'files.open'
    ])
    expect(ui.showToast).toHaveBeenCalledTimes(1)
  })

  it('creates nothing when the status read itself fails, since ownership needs that read', async () => {
    const host = hostClient({ status: [failure('runtime_error', 'status_failed')] })
    const ui = mount(host.client)

    await tapMarkdownNote()

    expect(host.methods()).toEqual(['status.get'])
    expect(ui.showToast).toHaveBeenCalledWith('status_failed', 1800)
    expect(ui.showToast).not.toHaveBeenCalledWith(MARKDOWN_NOTE_NEEDS_HOST_UPDATE_MESSAGE, 1800)
  })
})
