import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { GeneratedInputNotices } from './GeneratedInputNotices'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../src/shared/terminal-runtime-capabilities'

const writeText = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
type BannerProps = { message: string; action: { onPress: () => void }; onDismiss: () => void }
vi.mock('./HostRouteNoticeBanner', () => ({
  HostRouteNoticeBanner: (props: BannerProps) => createElement('notice', props)
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
