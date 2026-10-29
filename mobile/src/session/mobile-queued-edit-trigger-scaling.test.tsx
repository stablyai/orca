import { mobileQueuedEditHarness, withText } from './mobile-queued-edit-hook.test-fixture'
import { countedQueuedEditPublication } from '../../../src/shared/queued-edit-publication.test-fixture'
import * as publication from '../../../src/shared/queued-message-edit-publication'
import * as eligibility from '../../../src/shared/queued-message-edit-command'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileNativeChatComposerMenu } from './native-chat/composer/use-mobile-native-chat-composer-menu'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { MobileComposerStructuredCatalog } from './native-chat/composer/mobile-native-chat-composer-menu'
afterEach(() => vi.restoreAllMocks())
const { state, mount, sendRequest } = mobileQueuedEditHarness()
it.each([10, 100])(
  'actual phone hook bounds publication-key reads with %i fresh Q/C/R rows',
  async (n) => {
    const counter = countedQueuedEditPublication()
    vi.spyOn(publication, 'queuedEditPublicationKey').mockImplementation(counter.key)
    const message = queuedDraft({ messageId: 'target' })
    await mount(message)
    act(() => state.hook!.queued.editor!.cancel())
    const rows = () => [
      ...Array.from({ length: n - 1 }, (_, i) => queuedDraft({ messageId: `other-${i}` })),
      message
    ]
    const submissions = () =>
      Array.from({ length: n }, (_, i) => ({
        clientMessageId: `s${i}`,
        queuedMessageId: `unused-${i}`,
        fence: 3,
        payloadFingerprint: 'other',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }))
    counter.reset()
    act(() =>
      state.listener?.(snapshotEvent({ queuedMessages: rows(), submissions: submissions() }))
    )
    expect(counter.reads).toBe(0)
    await act(async () => {
      await state.hook!.queued.edit!('target')
    })
    counter.reset()
    act(() =>
      state.listener?.(snapshotEvent({ queuedMessages: rows(), submissions: submissions() }))
    )
    expect(counter.reads).toBeGreaterThanOrEqual(3 * n)
    expect(counter.reads).toBeLessThanOrEqual(3 * n + 2)
    expect(state.hook!.queued.editor).toBeDefined()
    act(() => state.hook!.queued.editor!.change('saved'))
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('lost')))
    await act(async () => {
      await state.hook!.queued.editor!.save()
    })
    counter.reset()
    act(() =>
      state.listener?.(
        snapshotEvent({
          queuedMessages: [
            ...rows().slice(0, -1),
            { ...message, body: withText(message.body, 'saved') }
          ],
          submissions: submissions()
        })
      )
    )
    expect(counter.reads).toBeLessThanOrEqual(3 * n + 2)
    expect(state.hook!.queued.editor).toBeUndefined()
  }
)
it.each([10, 100])(
  'actual phone menu reuses one eligibility preparation across query/all-token paths for %i rows',
  async (n) => {
    const prepare = vi.spyOn(eligibility, 'prepareQueuedMessageEditText')
    const reported = () =>
      Array.from({ length: n }, (_, i) => ({ name: `provider-${i}`, kind: 'command' as const }))
    const catalog: MobileComposerStructuredCatalog = {
      reported: reported(),
      conversationCommands: []
    }
    let menu!: ReturnType<typeof useMobileNativeChatComposerMenu>
    function Menu({
      value = '',
      agent = 'claude',
      editing = true,
      structured = catalog
    }: {
      value?: string
      agent?: string
      editing?: boolean
      structured?: MobileComposerStructuredCatalog
    }) {
      menu = useMobileNativeChatComposerMenu({
        value,
        agent,
        structuredCatalog: structured,
        filePaths: [],
        onChangeText: () => {},
        focusField: () => {},
        editing
      })
      return null
    }
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(createElement(Menu))
    })
    try {
      expect(prepare).toHaveBeenCalledTimes(1)
      for (const value of ['/', '/p', '/provider', '/provider-9']) {
        act(() => renderer.update(createElement(Menu, { value })))
        act(() => menu.onSelectionChange({ start: value.length, end: value.length }))
      }
      expect(menu.rows.length).toBeGreaterThan(0)
      expect(prepare).toHaveBeenCalledTimes(1)
      act(() => renderer.update(createElement(Menu, { value: '/', editing: false })))
      expect(prepare).toHaveBeenCalledTimes(1)
      act(() =>
        renderer.update(
          createElement(Menu, { value: '/', structured: { ...catalog, reported: reported() } })
        )
      )
      expect(prepare).toHaveBeenCalledTimes(2)
      act(() => renderer.update(createElement(Menu, { value: '/', agent: 'codex' })))
      expect(prepare).toHaveBeenCalledTimes(3)
    } finally {
      act(() => renderer.unmount())
    }
  }
)
