import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_NAVIGATION_CAPABILITY,
  CONVERSATION_PROJECT_VISIBILITY_CAPABILITY,
  SetConversationPreferenceParams,
  updateConversationPreference
} from '../../../src/shared/conversation-navigation-preferences'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { INITIAL_MOBILE_VIEW, type MobileViewState } from '../worktree/workspace-view-settings'
import { useConversationPreferences } from './use-conversation-preferences'

function endpoint() {
  let preferences = { revision: 0, entries: {} }
  let generation = 0
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (_method, params) => {
    preferences = updateConversationPreference(
      preferences,
      SetConversationPreferenceParams.parse(params)
    )
    return { id: 'write', ok: true, result: { preferences } }
  })
  return {
    client: { ...new FakeSession('connected'), getGeneration: () => generation, sendRequest },
    sendRequest,
    advanceGeneration: () => {
      generation += 1
    }
  }
}

describe('host-owned mobile conversation preferences', () => {
  it('applies atomic chat changes and rejects a prior host completion after cutover', async () => {
    const first = endpoint()
    const second = endpoint()
    let client: RpcClient = first.client
    let hostId = 'first'
    let hostCapabilities = [CONVERSATION_NAVIGATION_CAPABILITY]
    const observed: {
      current: ReturnType<typeof useConversationPreferences> | null
      view: MobileViewState
    } = { current: null, view: INITIAL_MOBILE_VIEW }
    const viewRef = { current: INITIAL_MOBILE_VIEW }
    function Probe() {
      const [view, setView] = useState<MobileViewState>(INITIAL_MOBILE_VIEW)
      viewRef.current = view
      observed.view = view
      observed.current = useConversationPreferences({
        client,
        hostId,
        connState: 'connected',
        hostCapabilities,
        state: { view, viewRef, setView }
      })
      return null
    }
    let tree: ReactTestRenderer | undefined
    try {
      await act(async () => {
        tree = create(createElement(Probe))
      })
      await act(async () => {
        expect(await observed.current?.setPreference('chat', { pinned: true })).toBe(true)
      })
      expect(observed.view.conversationPreferences).toEqual({
        revision: 1,
        entries: { chat: { pinned: true } }
      })

      await act(async () => {
        expect(await observed.current?.setProjectHidden('project', 'Notes', true)).toBe(false)
      })
      expect(first.sendRequest).toHaveBeenCalledTimes(1)
      hostCapabilities = [
        CONVERSATION_NAVIGATION_CAPABILITY,
        CONVERSATION_PROJECT_VISIBILITY_CAPABILITY
      ]
      await act(async () => tree?.update(createElement(Probe)))
      await act(async () => {
        expect(await observed.current?.setProjectHidden('project', 'Notes', true)).toBe(true)
      })
      expect(observed.view.conversationPreferences?.hiddenProjects).toEqual({ project: 'Notes' })
      expect(observed.view.conversationPreferences?.entries).toEqual({ chat: { pinned: true } })
      await act(async () => {
        expect(await observed.current?.setProjectHidden('project', 'Notes', false)).toBe(true)
      })
      expect(observed.view.conversationPreferences?.hiddenProjects).toEqual({})

      let resolveOld: (reply: RpcResponse) => void = () => {}
      first.sendRequest.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          })
      )
      let pending: Promise<boolean> | undefined
      act(() => {
        pending = observed.current?.setPreference('chat', { archived: true })
      })
      expect(observed.current?.writing).toBe(true)
      client = second.client
      hostId = 'second'
      await act(async () => tree?.update(createElement(Probe)))
      expect(observed.current?.writing).toBe(false)
      await act(async () => {
        expect(await observed.current?.setPreference('second-chat', { archived: true })).toBe(true)
      })
      expect(observed.view.conversationPreferences?.entries).toEqual({
        'second-chat': { archived: true }
      })

      await act(async () => {
        resolveOld({
          id: 'old-write',
          ok: true,
          result: { preferences: { revision: 999, entries: { chat: { archived: true } } } }
        })
        expect(await pending).toBe(false)
      })
      expect(observed.view.conversationPreferences?.entries).toEqual({
        'second-chat': { archived: true }
      })
      second.sendRequest.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          })
      )
      act(() => {
        pending = observed.current?.setPreference('second-chat', { pinned: true })
      })
      second.advanceGeneration()
      await act(async () => tree?.update(createElement(Probe)))
      expect(observed.current?.writing).toBe(false)
      await act(async () => {
        resolveOld({
          id: 'old-generation',
          ok: true,
          result: {
            preferences: { revision: 999, entries: { 'second-chat': { pinned: true } } }
          }
        })
        expect(await pending).toBe(false)
      })
      expect(observed.view.conversationPreferences?.entries).toEqual({
        'second-chat': { archived: true }
      })
    } finally {
      act(() => tree?.unmount())
    }
  })
})
