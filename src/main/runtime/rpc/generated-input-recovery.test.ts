import './unused-default-rpc-methods.test-fixture'
import { expect, it } from 'vitest'
import { GeneratedAgentInputNotices } from '../generated-agent-input-notices'
import { GENERATED_INPUT_METHODS } from './methods/generated-input'
import type { RpcContext } from './core'
import { createGeneratedInputNoticeFeed } from '../../../shared/generated-input-notice-feed'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'

function harness() {
  const notices = new GeneratedAgentInputNotices()
  const cleanups = new Map<string, () => void>()
  const runtime = {
    generatedInputNotices: notices,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => cleanups.get(id)?.()
  }
  // SAFETY: these handlers only consume the notice owner and subscription registry above.
  const context = { runtime, connectionId: 'viewer' } as unknown as RpcContext
  const method = (name: string) => {
    const found = GENERATED_INPUT_METHODS.find((entry) => entry.name === name)
    if (!found) {
      throw new Error(`missing ${name}`)
    }
    return found
  }
  const subscribe = method('terminal.generatedInputNotices.subscribe')
  const page = method('terminal.generatedInputNotices.page')
  const dismiss = method('terminal.dismissGeneratedInputNotice')
  const wire: string[] = []
  const views: GeneratedAgentInputNotice[][] = []
  const pageReads: (() => void)[] = []
  let holdPages = false
  const feed = createGeneratedInputNoticeFeed({
    readPage: async (from) => {
      if (holdPages) {
        await new Promise<void>((resolve) => pageReads.push(resolve))
      }
      const result = await page.handler(from ?? {}, context)
      wire.push(JSON.stringify(result))
      return result
    },
    onChange: (current) => views.push(current)
  })
  const connect = () =>
    'stream' in subscribe
      ? subscribe.handler(null, context, (message) => {
          wire.push(JSON.stringify(message))
          feed.receive(message)
        })
      : Promise.reject(new Error('not a stream'))
  const add = (text: string) =>
    notices.add({
      agent: 'claude',
      text,
      handle: 'h',
      worktreeId: 'w',
      ptyId: null,
      certainty: 'not-sent'
    })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    notices,
    cleanups,
    context,
    dismiss,
    wire,
    views,
    connect,
    add,
    settle,
    pageReads,
    hold: (on: boolean) => (holdPages = on)
  }
}

it('reconnects to retained prompts far above the paired-transport cap in bounded frames, text exact', async () => {
  const h = harness()
  // Eight legal 512 KiB prompts once made a single 4.19 MB list event that closed the phone's session.
  const texts = Array.from({ length: 8 }, (_, i) => `${i}\n${'é"\\'.repeat((512 * 1024) / 3)}`)
  for (const text of texts) {
    h.add(text)
  }
  void h.connect()
  await h.settle()
  await h.settle()
  const last = h.views.at(-1)!
  expect(last.map((notice) => notice.text)).toEqual(texts)
  for (const frame of h.wire) {
    expect(Buffer.byteLength(frame)).toBeLessThan(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2)
  }
  // A later add sends only itself.
  h.wire.length = 0
  h.add('one more')
  expect(h.wire.join('')).not.toContain(texts[0].slice(0, 64))
  expect(
    h.views
      .at(-1)!
      .map((notice) => notice.text)
      .at(-1)
  ).toBe('one more')
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
})

it('never revives a notice dismissed while the snapshot is still paging, and dismissal is idempotent', async () => {
  const h = harness()
  h.add('first')
  h.add('second')
  const [first] = [...h.notices.page().frames]
  h.hold(true)
  void h.connect()
  await h.settle()
  // Another client dismisses before this client's first page is served.
  await h.dismiss.handler({ id: first.id }, h.context)
  await h.dismiss.handler({ id: first.id }, h.context)
  h.add('third')
  h.hold(false)
  h.pageReads.splice(0).forEach((release) => release())
  await h.settle()
  await h.settle()
  expect(
    h.views
      .at(-1)!
      .map((notice) => notice.text)
      .toSorted()
  ).toEqual(['second', 'third'])
  for (const cleanup of h.cleanups.values()) {
    cleanup()
  }
})
