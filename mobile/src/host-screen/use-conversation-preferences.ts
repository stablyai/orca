import { useRef, useState } from 'react'
import {
  CONVERSATION_NAVIGATION_CAPABILITY,
  CONVERSATION_PROJECT_VISIBILITY_CAPABILITY,
  type ConversationPreference,
  type SetConversationPreferenceParams
} from '../../../src/shared/conversation-navigation-preferences'
import type { z } from 'zod'
import type { HostScreenController } from './use-host-screen-controller'
import { conversationPreferenceWrite } from './host-screen-operations'
import { conversationCopy } from './conversation-copy'

export function useConversationPreferences(
  controller: Pick<HostScreenController, 'client' | 'hostId' | 'connState' | 'hostCapabilities'> & {
    state: Pick<HostScreenController['state'], 'view' | 'viewRef' | 'setView'>
  }
) {
  const { client, hostId, connState, state, hostCapabilities } = controller
  const preferences = state.view.conversationPreferences
  const supported =
    preferences !== undefined || hostCapabilities.includes(CONVERSATION_NAVIGATION_CAPABILITY)
  type WriteOwner = { client: typeof client; hostId: typeof hostId; generation: number }
  const generation = client?.getGeneration?.() ?? 0
  const owns = (value: WriteOwner | null) =>
    value?.client === client && value.hostId === hostId && value.generation === generation
  const [writingOwner, setWriting] = useState<WriteOwner | null>(null)
  const [errorOwner, setError] = useState<(WriteOwner & { message: string }) | null>(null)
  const locked = useRef<WriteOwner | null>(null)
  const acceptedOwner = useRef<WriteOwner | null>(null)
  const owner = useRef({ client, hostId, connState })
  owner.current = { client, hostId, connState }
  const projectVisibilitySupported = hostCapabilities.includes(
    CONVERSATION_PROJECT_VISIBILITY_CAPABILITY
  )
  async function writePreference(
    params: z.infer<typeof SetConversationPreferenceParams>
  ): Promise<boolean> {
    if (!client || !supported || connState !== 'connected' || owns(locked.current)) {
      return false
    }
    const request = { client, hostId, generation }
    const current = () =>
      owner.current.client === client &&
      owner.current.hostId === hostId &&
      owner.current.connState === 'connected' &&
      generation === (client.getGeneration?.() ?? 0)
    locked.current = request
    setWriting(request)
    setError(null)
    try {
      const reply = await conversationPreferenceWrite.request(client, params)
      if (!current()) {
        return false
      }
      const result = conversationPreferenceWrite.interpret(reply)
      if (!result.accepted) {
        throw new Error('conversation_preference_refused')
      }
      if (
        !owns(acceptedOwner.current) ||
        result.value.preferences.revision >=
          (state.viewRef.current.conversationPreferences?.revision ?? 0)
      ) {
        acceptedOwner.current = request
        const next = { ...state.viewRef.current, conversationPreferences: result.value.preferences }
        state.viewRef.current = next
        state.setView(next)
      }
      return true
    } catch {
      if (current()) {
        setError({ ...request, message: conversationCopy().saveFailed })
      }
      return false
    } finally {
      if (locked.current === request) {
        locked.current = null
      }
      setWriting((pending) => (pending === request ? null : pending))
    }
  }
  return {
    preferences,
    supported,
    writing: owns(writingOwner),
    error: owns(errorOwner) ? (errorOwner?.message ?? '') : '',
    setPreference: (key: string, patch: ConversationPreference) =>
      writePreference({ key, ...patch }),
    projectVisibilitySupported,
    setProjectHidden: (projectKey: string, label: string, hidden: boolean) =>
      projectVisibilitySupported
        ? writePreference({ projectKey, label, hidden })
        : Promise.resolve(false)
  }
}
