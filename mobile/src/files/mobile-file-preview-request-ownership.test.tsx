import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileFilePreviewRouteState } from './mobile-file-preview-route'
import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'

const connection = vi.hoisted((): { client: RpcClient | null } => ({ client: null }))
vi.mock('../transport/host-client-hooks', () => ({
  useForceReconnect: () => null,
  useHostClient: () => ({ client: connection.client, state: 'connected', clientId: null })
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  Alert: { alert() {} },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 })
}))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Save: 'Icon' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back() {}, canGoBack: () => false, push() {} })
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./MobileFileMediaPreview', () => ({ MobileFileMediaPreview: () => null }))
vi.mock('./MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: 'MobileFileMarkdownPreview'
}))
vi.mock('../components/MobileSourceCopyButton', () => ({ MobileSourceCopyButton: () => null }))
vi.mock('./MobileFilePreviewSourceText', () => ({
  MobileFilePreviewSourceText: 'MobileFilePreviewSourceText'
}))

function deferred() {
  let resolve: (reply: RpcResponse) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<RpcResponse>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function ok(result: unknown): RpcResponse {
  return { id: 'preview', ok: true, result, _meta: { runtimeId: 'host' } }
}
function content(text: string): RpcResponse {
  return ok({ content: text, truncated: false, byteLength: text.length })
}
function route(path: string, terminalArtifact = false): MobileFilePreviewRouteState {
  return {
    ok: true,
    params: {
      hostId: 'host',
      worktreeId: 'folder:/repo',
      ...(terminalArtifact
        ? {
            source: 'terminalArtifact',
            absolutePath: path,
            grantId: 'old-grant',
            terminal: 'pty',
            pathText: path
          }
        : { relativePath: path })
    }
  }
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  connection.client = null
})

async function mount() {
  const reads: { method: string; params: unknown; reply: ReturnType<typeof deferred> }[] = []
  const client: RpcClient = {
    sendRequest: vi.fn((method: string, params?: unknown) => {
      const reply = deferred()
      reads.push({ method, params, reply })
      return reply.promise
    }),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport() {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground() {},
    close() {}
  }
  connection.client = client
  return {
    reads,
    async open(next: MobileFilePreviewRouteState) {
      await act(async () => {
        if (renderer) {
          renderer.update(createElement(MobileFilePreviewScreen, { route: next }))
        } else {
          renderer = create(createElement(MobileFilePreviewScreen, { route: next }))
        }
      })
    },
    currentText() {
      if (!renderer) {
        throw new Error('Preview did not mount')
      }
      return findByHostType(renderer.root, 'MobileFilePreviewSourceText').props.content
    }
  }
}

describe('file preview read ownership', () => {
  it('keeps the replacement file when a departed file read rejects later', async () => {
    const preview = await mount()
    await preview.open(route('old.txt'))
    await preview.open(route('new.txt'))
    expect(preview.reads.map(({ params }) => params)).toEqual([
      { worktree: 'id:folder:/repo', relativePath: 'old.txt' },
      { worktree: 'id:folder:/repo', relativePath: 'new.txt' }
    ])
    await act(async () => {
      preview.reads[1]!.reply.resolve(content('New file contents'))
    })
    expect(preview.currentText()).toBe('New file contents')
    await act(async () => {
      preview.reads[0]!.reply.reject(new Error('Old file disconnected'))
    })
    expect(JSON.stringify(renderer?.toJSON())).not.toContain(
      'Unable to reach the desktop filesystem'
    )
    expect(preview.currentText()).toBe('New file contents')
  })

  it('does not replace the current source when an old terminal grant refresh finishes', async () => {
    const preview = await mount()
    await preview.open(route('/tmp/old.txt', true))
    await act(async () => {
      preview.reads[0]!.reply.resolve({
        id: 'expired',
        ok: false,
        error: { code: 'terminal_file_grant_expired', message: 'terminal_file_grant_expired' }
      })
    })
    expect(preview.reads[1]!.method).toBe('files.resolveTerminalPath')
    await preview.open(route('new.txt'))
    await act(async () => {
      preview.reads[2]!.reply.resolve(content('New file contents'))
    })
    await act(async () => {
      preview.reads[1]!.reply.resolve(
        ok({
          exists: true,
          isDirectory: false,
          openTarget: { kind: 'absolute-file', absolutePath: '/tmp/old.txt', grantId: 'new-grant' }
        })
      )
    })
    expect(preview.reads).toHaveLength(3)
    expect(preview.currentText()).toBe('New file contents')
    expect(JSON.stringify(renderer?.toJSON())).not.toContain('Unable to load preview')
  })

  it('does not request a grant for a source retired before its refusal arrives', async () => {
    const preview = await mount()
    await preview.open(route('/tmp/old.txt', true))
    await preview.open(route('new.txt'))
    await act(async () => {
      preview.reads[1]!.reply.resolve(content('New file contents'))
    })
    await act(async () => {
      preview.reads[0]!.reply.resolve({
        id: 'expired',
        ok: false,
        error: {
          code: 'terminal_file_grant_expired',
          message: 'terminal_file_grant_expired'
        }
      })
    })
    expect(preview.reads).toHaveLength(2)
    expect(preview.currentText()).toBe('New file contents')
  })

  it('still recovers a current terminal artifact grant and exposes its editable content', async () => {
    const preview = await mount()
    await preview.open(route('/tmp/current.txt', true))
    await act(async () => {
      preview.reads[0]!.reply.resolve({
        id: 'expired',
        ok: false,
        error: {
          code: 'terminal_file_grant_expired',
          message: 'terminal_file_grant_expired'
        }
      })
    })
    await act(async () => {
      preview.reads[1]!.reply.resolve(
        ok({
          exists: true,
          isDirectory: false,
          openTarget: {
            kind: 'absolute-file',
            absolutePath: '/tmp/current.txt',
            grantId: 'new-grant'
          }
        })
      )
    })
    const recoveredReads = preview.reads.slice(2)
    expect(recoveredReads).toHaveLength(1)
    expect(recoveredReads[0]!.params).toMatchObject({
      absolutePath: '/tmp/current.txt',
      grantId: 'new-grant'
    })
    await act(async () => {
      recoveredReads[0]!.reply.resolve(content('Recovered editable contents'))
    })
    const input = renderer?.root.findByProps({ accessibilityLabel: 'current.txt editor' })
    expect(input?.props.value).toBe('Recovered editable contents')
  })
})
