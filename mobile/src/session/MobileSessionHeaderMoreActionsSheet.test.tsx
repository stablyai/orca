import { useState, type ReactNode } from 'react'
import { Pressable, Text } from 'react-native'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { BottomDrawer } from '../components/BottomDrawer'
import { MobileSessionHeaderMoreActionsSheet } from './MobileSessionHeaderMoreActionsSheet'
import { useMobileSessionDeleteAction } from './use-mobile-session-delete-action'

let blur: (() => void) | undefined
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      useEffect(() => {
        const cleanup = effect()
        blur = cleanup ?? undefined
        return cleanup
      }, [effect])
    }
  }
})

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ ListChecks: 'Icon', Edit3: 'Icon', Trash2: 'Icon' }))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  blur = undefined
})

async function mount({
  worktreeId = 'repo::worktree',
  floating = false,
  connected = true,
  showAgentSessionHistory = true,
  showChecks = true,
  executionHost
}: {
  worktreeId?: string
  floating?: boolean
  connected?: boolean
  showAgentSessionHistory?: boolean
  showChecks?: boolean
  executionHost?: ExecutionHostId
} = {}) {
  const client = new FakeSession(connected ? 'connected' : 'disconnected')
  const leaveSession = vi.fn()
  const showToast = vi.fn()
  const router = mountFixture<Parameters<typeof useMobileSessionDeleteAction>[0]['router']>({
    replace: leaveSession
  })
  let switchWorkspace: ((id: string) => void) | undefined
  function Harness() {
    const [currentWorktreeId, setWorktreeId] = useState(worktreeId)
    switchWorkspace = setWorktreeId
    const [visible, setVisible] = useState(true)
    const deletion = useMobileSessionDeleteAction({
      client: executionHost ? scopeRpcClientToExecutionHost(client, executionHost) : client,
      connState: client.getState(),
      hostId: 'host',
      worktreeId: currentWorktreeId,
      isFloatingWorkspaceRoute: floating,
      router,
      setShowHeaderMoreActions: setVisible,
      showToast
    })
    return (
      <MobileSessionHeaderMoreActionsSheet
        key={deletion.deleteWorkspaceScope}
        visible={visible}
        showAgentSessionHistory={showAgentSessionHistory}
        showChecks={showChecks}
        showDelete={!floating}
        deleteDisabled={deletion.deleteWorkspaceDisabled}
        worktreeName="Example workspace"
        isFolderWorkspace={currentWorktreeId.startsWith('folder:')}
        onDelete={() => void deletion.handleDeleteWorkspace()}
        onOpenAgentSessionHistory={vi.fn()}
        onOpenChecks={vi.fn()}
        onClose={() => setVisible(false)}
      />
    )
  }
  await act(async () => {
    renderer = create(
      <WorkspaceExecutionHostContext.Provider value={executionHost}>
        <Harness />
      </WorkspaceExecutionHostContext.Provider>
    )
  })
  if (!renderer) {
    throw new Error('Sheet did not mount')
  }
  const root = renderer.root
  const buttons = () => root.findAllByType(Pressable)
  const button = (label: string) => {
    const found = buttons().find((node) =>
      node.findAllByType(Text).some((text) => text.children.includes(label))
    )
    if (!found) {
      throw new Error(`Missing button: ${label}`)
    }
    return found
  }
  const press = async (node: ReactTestInstance) => {
    await act(async () => node.props.onPress())
  }
  const openConfirmation = async () => {
    await press(button('Delete'))
    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(buttons()).toHaveLength(0)
    const drawer = root.findAllByType(BottomDrawer)[0]
    await act(async () => drawer.props.onAfterClose?.())
  }
  return {
    client,
    leaveSession,
    showToast,
    root,
    button,
    press,
    openConfirmation,
    switchWorkspace: async (id: string) => {
      await act(async () => switchWorkspace?.(id))
    }
  }
}

describe('session menu workspace deletion', () => {
  it('keeps the other actions and waits for dismissal before confirming; Cancel preserves the workspace', async () => {
    const sheet = await mount()
    expect(sheet.button('Agent History')).toBeDefined()
    expect(sheet.button('Checks')).toBeDefined()
    await sheet.openConfirmation()
    expect(
      sheet.root.findAllByType(Text).some((node) => node.children.includes('Delete Worktree'))
    ).toBe(true)
    await sheet.press(sheet.button('Cancel'))
    expect(sheet.client.sendRequest).not.toHaveBeenCalled()
    expect(sheet.leaveSession).not.toHaveBeenCalled()
  })

  it.each(['repo::worktree', 'folder:project'])(
    'deletes %s only after confirmation and leaves on acceptance',
    async (worktreeId) => {
      const sheet = await mount({ worktreeId, showAgentSessionHistory: false, showChecks: false })
      await sheet.openConfirmation()
      await sheet.press(sheet.button('Delete'))
      expect(sheet.client.sendRequest).toHaveBeenCalledExactlyOnceWith('worktree.rm', {
        worktree: `id:${worktreeId}`,
        force: true
      })
      expect(sheet.leaveSession).toHaveBeenCalledExactlyOnceWith('/h/host')
      expect(sheet.showToast).not.toHaveBeenCalled()
    }
  )

  it.each(['refused', 'rejected'])(
    'stays in the session and reports a %s deletion',
    async (failure) => {
      const sheet = await mount()
      if (failure === 'refused') {
        sheet.client.sendRequest.mockResolvedValue({
          id: 'rm',
          ok: false,
          error: { code: 'runtime_error', message: 'Cannot delete' }
        })
      } else {
        sheet.client.sendRequest.mockRejectedValue(new Error('Connection lost'))
      }
      await sheet.openConfirmation()
      await sheet.press(sheet.button('Delete'))
      expect(sheet.leaveSession).not.toHaveBeenCalled()
      expect(sheet.showToast).toHaveBeenCalledWith("Couldn't delete workspace. Try again.", 2500)
    }
  )

  it('waits for acknowledgment before navigating', async () => {
    const sheet = await mount()
    let accept: ((reply: RpcResponse) => void) | undefined
    sheet.client.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve
        })
    )
    await sheet.openConfirmation()
    await sheet.press(sheet.button('Delete'))
    expect(sheet.leaveSession).not.toHaveBeenCalled()
    await act(async () => accept?.({ id: 'rm', ok: true, result: { removed: true } }))
    expect(sheet.leaveSession).toHaveBeenCalledOnce()
  })

  it('disables deletion while offline', async () => {
    const sheet = await mount({ connected: false })
    expect(sheet.button('Delete').props.disabled).toBe(true)
  })

  it('offers no deletion for the floating workspace', async () => {
    const sheet = await mount({ floating: true })
    expect(() => sheet.button('Delete')).toThrow('Missing button')
  })

  it('routes deletion through the workspace server', async () => {
    const sheet = await mount({ executionHost: 'runtime:server' })
    await sheet.openConfirmation()
    await sheet.press(sheet.button('Delete'))
    expect(sheet.client.sendRequest).toHaveBeenCalledExactlyOnceWith(
      'worktree.rm',
      { worktree: 'id:repo::worktree', force: true },
      { envelope: { executionHost: 'runtime:server' } }
    )
    expect(sheet.leaveSession).toHaveBeenCalledExactlyOnceWith('/h/host')
  })

  it('refuses deletion if the connection drops after the confirmation opens', async () => {
    const sheet = await mount()
    await sheet.openConfirmation()
    sheet.client.publishState('disconnected')
    await sheet.press(sheet.button('Delete'))
    expect(sheet.client.sendRequest).not.toHaveBeenCalled()
    expect(sheet.leaveSession).not.toHaveBeenCalled()
  })

  it('sends one request for duplicate confirmation taps', async () => {
    const sheet = await mount()
    let accept: ((reply: RpcResponse) => void) | undefined
    sheet.client.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve
        })
    )
    await sheet.openConfirmation()
    const confirm = sheet.button('Delete')
    await act(async () => {
      confirm.props.onPress()
      confirm.props.onPress()
    })
    expect(sheet.client.sendRequest).toHaveBeenCalledOnce()
    await act(async () => accept?.({ id: 'rm', ok: true, result: { removed: true } }))
    expect(sheet.leaveSession).toHaveBeenCalledOnce()
  })

  it('dismisses an old confirmation when the workspace changes', async () => {
    const sheet = await mount()
    await sheet.openConfirmation()
    await sheet.switchWorkspace('another-workspace')
    expect(() => sheet.button('Delete')).toThrow('Missing button')
    expect(sheet.client.sendRequest).not.toHaveBeenCalled()
  })

  it.each(['blur', 'unmount', 'workspace-change'])(
    'does not navigate when deletion completes after %s',
    async (transition) => {
      const sheet = await mount()
      let accept: ((reply: RpcResponse) => void) | undefined
      sheet.client.sendRequest.mockImplementation(
        () =>
          new Promise((resolve) => {
            accept = resolve
          })
      )
      await sheet.openConfirmation()
      await sheet.press(sheet.button('Delete'))
      if (transition === 'workspace-change') {
        await sheet.switchWorkspace('another-workspace')
      } else {
        await act(async () => {
          if (transition === 'blur') {
            blur?.()
          } else {
            renderer?.unmount()
          }
        })
      }
      await act(async () => accept?.({ id: 'rm', ok: true, result: { removed: true } }))
      expect(sheet.leaveSession).not.toHaveBeenCalled()
      expect(sheet.showToast).not.toHaveBeenCalled()
    }
  )
})
