import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useMobileNativeChatPromptPresentation } from './use-mobile-native-chat-prompt-presentation'
import { mobileNativeChatPromptDismissals } from './mobile-native-chat-prompt-dismissals'
import type { MobileChatPermission } from './mobile-native-chat-permission'

const permission = (holdsComposer?: true): MobileChatPermission => ({
  ...(holdsComposer ? { holdsComposer } : {}),
  title: 'Trust this folder?',
  options: [{ label: 'Trust folder', send: '\r' }]
})

describe('useMobileNativeChatPromptPresentation', () => {
  let renderer: ReturnType<typeof create> | null = null
  let state: ReturnType<typeof useMobileNativeChatPromptPresentation> | null = null

  beforeEach(() => mobileNativeChatPromptDismissals.clearForTests())
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({ shown }: { shown: MobileChatPermission | null }): null {
    state = useMobileNativeChatPromptPresentation({
      permission: shown,
      waitStartedAt: 1,
      scopeKey: 'tab-1',
      sessionKey: 'session-1',
      observing: true,
      respondPermission: async () => true
    })
    return null
  }

  async function answer(shown: MobileChatPermission): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { shown }))
    })
    await act(async () => {
      await state?.respondPermission('\r')
    })
  }

  it('hides an ordinary approval once its answer was accepted', async () => {
    await answer(permission())
    expect(state?.permission).toBeNull()
  })

  // Why: the folder-trust dialog is still on screen until the host settles it.
  it('keeps a composer-holding card until its host status leaves', async () => {
    const shown = permission(true)
    await answer(shown)
    expect(state?.permission).toBe(shown)
    await act(async () => renderer?.update(createElement(Harness, { shown: null })))
    expect(state?.permission).toBeNull()
  })
})
