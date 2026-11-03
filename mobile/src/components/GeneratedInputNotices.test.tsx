import { createElement, Fragment, type ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { GeneratedInputNotices } from './GeneratedInputNotices'
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
// The older list's windowing is the platform list's; this stand-in renders every item it is given.
vi.mock('./OlderGeneratedInputNotices', () => ({
  MoreGeneratedInputNoticesRow: (props: RowProps) => createElement('more-row', props),
  OlderGeneratedInputNotices: <T,>(props: {
    items: readonly T[]
    keyOf: (item: T) => string
    render: (item: T) => ReactElement
  }) =>
    createElement(
      'older-list',
      null,
      props.items.map((item) =>
        createElement(Fragment, { key: props.keyOf(item) }, props.render(item))
      )
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
  'mounts one banner for %i notices collapsed, and every older one when expanded',
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
    // Expanded under this stand-in every older notice renders; on a device the bounded list
    // mounts only its window of them.
    expect(view.banners()).toHaveLength(n)
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
    expect(view.banners()).toHaveLength(n - 1)
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
