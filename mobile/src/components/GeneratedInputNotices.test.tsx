import { createElement, Fragment, type ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { GeneratedInputNotices } from './GeneratedInputNotices'
import { GeneratedInputNoticeList } from './generated-input-notice-list'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../src/shared/terminal-runtime-capabilities'

const writeText = vi.hoisted(() => vi.fn(async () => {}))
// Banner renders, for the population contract below.
const bannerRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
type BannerProps = { message: string; action: { onPress: () => void }; onDismiss: () => void }
// The per-server feed's host discovery reaches React Native; this case drives one runtime's feed.
vi.mock('../worktree/relay-hosts-feed', () => ({ useRelayHosts: () => [] }))
vi.mock('../transport/execution-host-scoped-rpc-client', () => ({
  scopeRpcClientToExecutionHost: (client: unknown) => client
}))
vi.mock('../transport/host-status-gates', () => ({
  useHostStatusGates: () => ({ hostCapabilities: [] })
}))
type RowProps = { label: string; expanded: boolean; onToggle: () => void }
// Drive the production parent's indexed access for one requested window; device QA covers layout.
vi.mock('./OlderGeneratedInputNotices', () => ({
  MoreGeneratedInputNoticesRow: (props: RowProps) => createElement('more-row', props),
  OlderGeneratedInputNotices: <T,>(props: {
    items: { size: number; at: (index: number) => T }
    keyOf: (item: T) => string
    render: (item: T) => ReactElement
  }) =>
    createElement(
      'older-list',
      { items: props.items },
      Array.from({ length: Math.min(4, Math.max(0, props.items.size - 1)) }, (_, index) =>
        props.items.at(index + 1)
      ).map((item) => createElement(Fragment, { key: props.keyOf(item) }, props.render(item)))
    )
}))
vi.mock('./HostRouteNoticeBanner', () => ({
  HostRouteNoticeBanner: (props: BannerProps) => {
    bannerRenders.count += 1
    return createElement('notice', props)
  }
}))

const frame = (chunk: string, offset: number, textLength: number) => ({
  id: 'refused',
  agent: 'claude',
  handle: 'h',
  worktreeId: 'w',
  ptyId: null,
  certainty: 'unconfirmed',
  textLength,
  offset,
  chunk
})

it('pages, copies only complete text, and dismisses on the runtime that owns the notice', async () => {
  let emit = (_payload: unknown): void => {}
  const sendRequest = vi.fn(async (method: string) =>
    method === 'terminal.generatedInputNotices.page'
      ? {
          id: 'page',
          ok: true as const,
          result: { session: 's', revision: 1, frames: [frame('exact\n', 0, 10)], next: null }
        }
      : { id: 'dismiss', ok: true as const, result: { dismissed: true } }
  )
  const client = stubRpcClient({
    sendRequest,
    subscribe: (_method, _params, listener) => {
      emit = listener
      return () => {}
    }
  })
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(
      createElement(GeneratedInputNotices, {
        client,
        capabilities: [GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY]
      })
    )
  })
  const mounted = renderer!
  const banners = () => mounted.root.findAll((node) => String(node.type) === 'notice')
  await act(async () => {
    emit({ type: 'ready', subscriptionId: 'sub', session: 's', revision: 1 })
  })
  // The page held only part of the text: no Copy of a partial prompt yet.
  expect(banners()).toHaveLength(0)
  await act(async () => {
    emit({ type: 'notice', session: 's', revision: 2, frame: frame('text', 6, 10) })
  })
  expect(banners()).toHaveLength(1)
  expect(banners()[0].props.message).toContain('may have received part')
  await act(async () => {
    banners()[0].props.action.onPress()
  })
  expect(writeText).toHaveBeenCalledExactlyOnceWith('exact\ntext')
  await act(async () => {
    banners()[0].props.onDismiss()
  })
  expect(sendRequest.mock.calls.map((call) => call.slice(0, 2))).toContainEqual([
    'terminal.dismissGeneratedInputNotice',
    { id: 'refused' }
  ])
  expect(banners()).toHaveLength(1)
  await act(async () => {
    emit({ type: 'dismissed', session: 's', revision: 3, id: 'refused' })
  })
  expect(banners()).toHaveLength(0)
  act(() => {
    mounted.unmount()
  })
})

async function mountNotices(n: number, submitted?: false) {
  let emit = (_payload: unknown): void => {}
  const frames = Array.from({ length: n }, (_, index) => ({
    ...frame(`text ${index}`, 0, `text ${index}`.length),
    id: `n${index}`,
    ...(submitted === false ? { submitted: false } : {})
  }))
  const sendRequest = vi.fn(async (method: string) =>
    method === 'terminal.generatedInputNotices.page'
      ? {
          id: 'page',
          ok: true as const,
          result: { session: 's', revision: n, frames, next: null }
        }
      : { id: 'dismiss', ok: true as const, result: { dismissed: true } }
  )
  const client = stubRpcClient({
    sendRequest,
    subscribe: (_method, _params, listener) => {
      emit = listener
      return () => {}
    }
  })
  let renderer: ReturnType<typeof create> | undefined
  act(() => {
    renderer = create(
      createElement(GeneratedInputNotices, {
        client,
        capabilities: [GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY]
      })
    )
  })
  const mounted = renderer!
  await act(async () => {
    emit({ type: 'ready', subscriptionId: 'sub', session: 's', revision: n })
  })
  return {
    mounted,
    sendRequest,
    emit: async (payload: unknown) => {
      await act(async () => emit(payload))
    },
    banners: () => mounted.root.findAll((node) => String(node.type) === 'notice'),
    rows: () => mounted.root.findAll((node) => String(node.type) === 'more-row')
  }
}

// The approved phone presentation: the newest notice as a banner plus one "<N> more" row; the
// older ones open in place in a bounded list and close again. Nothing is discarded.
it.each([1, 5, 100])(
  'mounts one banner for %i notices collapsed, and accesses only the expanded window',
  async (n) => {
    const view = await mountNotices(n)
    // Collapsed: the newest notice and, when there are older ones, one row.
    expect(view.banners()).toHaveLength(1)
    expect(view.banners()[0].props.message).toContain('may have received part')
    expect(view.rows()).toHaveLength(n > 1 ? 1 : 0)
    if (n === 1) {
      act(() => view.mounted.unmount())
      return
    }
    expect(view.rows()[0].props.label).toBe(
      n - 1 === 1 ? '1 more prompt not sent' : `${n - 1} more prompts not sent`
    )
    await act(async () => view.rows()[0].props.onToggle())
    expect(view.rows()[0].props.expanded).toBe(true)
    expect(view.banners()).toHaveLength(Math.min(n, 5))
    // An older notice keeps Copy and Dismiss.
    writeText.mockClear()
    await act(async () => view.banners()[1].props.action.onPress())
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`text ${n - 2}`)
    await act(async () => view.banners()[1].props.onDismiss())
    expect(view.sendRequest.mock.calls.map((call) => call.slice(0, 2))).toContainEqual([
      'terminal.dismissGeneratedInputNotice',
      { id: `n${n - 2}` }
    ])
    await view.emit({ type: 'dismissed', session: 's', revision: n + 1, id: `n${n - 2}` })
    expect(view.banners()).toHaveLength(Math.min(n - 1, 5))
    await act(async () => view.rows()[0]?.props.onToggle())
    expect(view.banners()).toHaveLength(1)
    act(() => view.mounted.unmount())
  }
)

it('renders only the new newest banner for a live notice, and says notes while every hidden one is a draft', async () => {
  const view = await mountNotices(100, false)
  expect(view.rows()[0].props.label).toBe('99 more notes not sent')
  bannerRenders.count = 0
  await view.emit({
    type: 'notice',
    session: 's',
    revision: 101,
    frame: { ...frame('y', 0, 1), id: 'new' }
  })
  expect(view.banners()).toHaveLength(1)
  expect(bannerRenders.count).toBe(1)
  // The new prompt is the newest; every hidden notice is still a draft.
  expect(view.rows()[0].props.label).toBe('100 more notes not sent')
  act(() => view.mounted.unmount())
})

// The production subscription and indexed view do work only for the requested visible rows.
// This stand-in requests four older rows; native list windowing is checked on the phone.
it.each([100, 1_000])('isolates visible rows and host subscriptions at %i notices', async (n) => {
  const view = await mountNotices(n)
  const otherHost = await mountNotices(n)
  await act(async () => view.rows()[0].props.onToggle())
  const select = vi.spyOn(GeneratedInputNoticeList.prototype, 'at')
  let revision = n
  const update = async (index: number) => {
    await view.emit({
      type: 'notice',
      session: 's',
      revision: ++revision,
      frame: {
        ...frame(`text ${index}`, 0, `text ${index}`.length),
        id: `n${index}`,
        certainty: 'not-sent'
      }
    })
  }
  try {
    bannerRenders.count = 0
    await update(0)
    // A hidden row's metadata changes neither the five mounted banners nor the other host.
    expect(bannerRenders.count).toBe(0)
    expect(select.mock.calls.length).toBeLessThanOrEqual(5)
    select.mockClear()
    await update(n - 2)
    expect(bannerRenders.count).toBe(1)
    expect(view.banners()[1].props.message).toContain("wasn't sent")
    expect(otherHost.banners()[0].props.message).toContain('may have received part')
    expect(select.mock.calls.length).toBeLessThanOrEqual(5)
    select.mockClear()
    bannerRenders.count = 0
    await view.emit({ type: 'dismissed', session: 's', revision: ++revision, id: 'n1' })
    expect(bannerRenders.count).toBe(0)
    expect(select.mock.calls.length).toBeLessThanOrEqual(5)
    expect(view.rows()[0].props.label).toBe(`${n - 2} more prompts not sent`)
  } finally {
    select.mockRestore()
    act(() => {
      view.mounted.unmount()
      otherHost.mounted.unmount()
    })
  }
})

it('keeps old list props on the live count and item source after a remote dismissal', async () => {
  const view = await mountNotices(6)
  await act(async () => view.rows()[0].props.onToggle())
  const previous = view.mounted.root.findByType('older-list' as never).props
    .items as GeneratedInputNoticeList
  expect(previous.size).toBe(6)
  await view.emit({ type: 'dismissed', session: 's', revision: 7, id: 'n0' })
  // A list-only scroll render can run with these earlier props before its parent commits.
  expect(previous.size).toBe(5)
  for (let index = 0; index < previous.size - 1; index += 1) {
    expect(previous.at(index + 1)?.key).toBeDefined()
  }
  act(() => view.mounted.unmount())
})
