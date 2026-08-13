import { createElement, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { MobileStructuredSessionCreateError } from './MobileStructuredSessionCreateError'
import {
  mobileStructuredCreateFingerprint,
  type MobileStructuredAgent
} from './mobile-structured-session-create'
import { useMobileStructuredSessionEntry } from './use-mobile-structured-session-entry'

const dependencies = vi.hoisted(() => ({
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000001')
}))

vi.mock('expo-crypto', () => ({ randomUUID: dependencies.randomUUID }))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({ AlertTriangle: 'AlertTriangle', X: 'X' }))
vi.mock('./use-mobile-structured-agent-session', () => ({
  useMobileStructuredAgentSession: () => ({ fence: null, submissions: [] })
}))
vi.mock('./use-mobile-structured-session-writes', () => ({
  useMobileStructuredSessionWrites: () => ({ setOption: vi.fn() })
}))
vi.mock('./use-mobile-structured-session-options', () => ({
  useMobileStructuredSessionOptions: () => ({})
}))
vi.mock('./use-mobile-structured-attachments', () => ({
  useMobileStructuredAttachments: () => ({})
}))

describe('mobile structured session create entry', () => {
  let renderer: ReactTestRenderer | null = null
  const closeDrawer = vi.fn()
  const onCreated = vi.fn()
  const onError = vi.fn()
  const setCreating = vi.fn()
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = { sendRequest } as RpcClient
  let createResponse: RpcResponse
  let targetAgent: MobileStructuredAgent

  function Harness() {
    const guard = useRef(false)
    const [createError, setCreateError] = useState('')
    const entry = useMobileStructuredSessionEntry({
      client,
      connected: true,
      drawerOpen: true,
      hostSupported: true,
      worktreeId: 'workspace-1',
      sessionId: null,
      sessionAgent: null,
      creationGuardRef: guard,
      setCreating,
      setCreateError,
      closeDrawer,
      onCreated,
      onError,
      getConnectionId: async () => 'connection-1'
    })
    return createElement(
      View,
      null,
      createElement(
        Pressable,
        {
          accessibilityLabel: 'Create chat session',
          onPress: () => entry.create(targetAgent)
        },
        createElement(Text, null, 'Chat session')
      ),
      createElement(MobileStructuredSessionCreateError, {
        message: createError,
        onDismiss: () => setCreateError('')
      })
    )
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    closeDrawer.mockReset()
    onCreated.mockReset()
    onError.mockReset()
    setCreating.mockReset()
    createResponse = {
      id: 'create',
      ok: true,
      result: { ok: false, refusal: { message: 'The host refused this session' } },
      _meta: { runtimeId: 'runtime-1' }
    }
    sendRequest.mockReset().mockImplementation(async (method) => {
      if (method === 'agentSession.createSupport') {
        return {
          id: 'support',
          ok: true,
          result: { supported: true },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      return createResponse
    })
    targetAgent = 'claude'
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function renderAndTap(): Promise<void> {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
        await Promise.resolve()
      })
    } finally {
      consoleSpy.mockRestore()
    }
    await vi.waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith('agentSession.createSupport', expect.anything())
    )

    await act(async () => {
      await renderer!.root
        .findByProps({ accessibilityLabel: 'Create chat session' })
        .props.onPress()
    })
  }

  it('sends create from the tap and keeps a host refusal visibly rendered', async () => {
    await renderAndTap()

    const createCall = sendRequest.mock.calls.find(([method]) => method === 'agentSession.create')
    expect(createCall).toBeDefined()
    expect(createCall?.[1]).toMatchObject({
      envelope: {
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        expectedRuntimeFence: null
      },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })
    const createParams = createCall?.[1] as {
      envelope: { sessionId: string; payloadFingerprint: string }
      worktree: string
    }
    expect(createParams.envelope.payloadFingerprint).toBe(
      mobileStructuredCreateFingerprint({
        sessionId: createParams.envelope.sessionId,
        worktree: createParams.worktree,
        agent: 'claude'
      })
    )
    expect(sendRequest).toHaveBeenCalledWith('agentSession.createSupport', {
      worktree: 'id:workspace-1',
      agent: 'claude'
    })
    expect(sendRequest).toHaveBeenCalledWith('agentSession.createSupport', {
      worktree: 'id:workspace-1',
      agent: 'codex'
    })
    expect(onError).toHaveBeenCalledWith('The host refused this session')
    expect(
      renderer.root.findByProps({ accessibilityRole: 'alert' }).findByType('Text').children
    ).toEqual(['The host refused this session'])
  })

  it('renders a dispatcher rejection instead of collapsing it to a silent no-op', async () => {
    createResponse = {
      id: 'create',
      ok: false,
      error: { code: 'invalid_params', message: 'Create envelope was rejected' },
      _meta: { runtimeId: 'runtime-1' }
    }

    await renderAndTap()

    expect(onError).toHaveBeenCalledWith('Create envelope was rejected')
    expect(
      renderer!.root.findByProps({ accessibilityRole: 'alert' }).findByType('Text').children
    ).toEqual(['Create envelope was rejected'])
  })
})
