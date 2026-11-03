import { createElement } from 'react'
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

// Z2-1: after the snapshot, one live add renders one banner and one dismissal renders none,
// whatever the retained population; the rest keep their rendered banners.
it.each([100, 1000])(
  'renders only the changed banner for a live change among %i notices',
  async (n) => {
    let emit = (_payload: unknown): void => {}
    const frames = Array.from({ length: n }, (_, index) => ({
      ...frame('x', 0, 1),
      id: `n${index}`
    }))
    const client = stubRpcClient({
      sendRequest: vi.fn(async () => ({
        id: 'page',
        ok: true as const,
        result: { session: 's', revision: n, frames, next: null }
      })),
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
      emit({ type: 'ready', subscriptionId: 'sub', session: 's', revision: n })
    })
    expect(banners()).toHaveLength(n)
    bannerRenders.count = 0
    await act(async () => {
      emit({
        type: 'notice',
        session: 's',
        revision: n + 1,
        frame: { ...frame('y', 0, 1), id: 'new' }
      })
    })
    expect(banners()).toHaveLength(n + 1)
    expect(bannerRenders.count).toBe(1)
    bannerRenders.count = 0
    await act(async () => {
      emit({ type: 'dismissed', session: 's', revision: n + 2, id: 'new' })
    })
    expect(banners()).toHaveLength(n)
    expect(bannerRenders.count).toBe(0)
    act(() => {
      mounted.unmount()
    })
  }
)
