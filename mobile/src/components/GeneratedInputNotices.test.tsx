import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { GeneratedInputNotices } from './GeneratedInputNotices'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { GENERATED_INPUT_RECOVERY_RUNTIME_CAPABILITY } from '../../../src/shared/terminal-runtime-capabilities'

const writeText = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
vi.mock('./HostRouteNoticeBanner', () => ({
  HostRouteNoticeBanner: (props: object) => createElement('notice', props)
}))

it('projects reconnect snapshots, preserves Copy, and removes notices only on host dismissal', async () => {
  let emit = (_payload: unknown): void => {}
  const sendRequest = vi.fn(async () => ({
    id: 'dismiss',
    ok: true as const,
    result: { dismissed: true }
  }))
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
  if (!renderer) {
    throw new Error('not mounted')
  }
  const notices = [
    { id: 'refused', agent: 'claude', text: 'exact\ntext', certainty: 'unconfirmed' }
  ]
  const mounted = renderer
  const banners = () => mounted.root.findAll((node) => String(node.type) === 'notice')
  act(() => {
    emit({ type: 'ready', snapshot: { generatedInputNotices: notices } })
  })
  expect(banners()).toHaveLength(1)
  expect(banners()[0].props.message).toContain('may have received part')
  await act(async () => {
    banners()[0].props.action.onPress()
  })
  expect(writeText).toHaveBeenCalledExactlyOnceWith('exact\ntext')
  expect(sendRequest).not.toHaveBeenCalled()
  act(() => {
    emit({ type: 'ready', snapshot: { generatedInputNotices: notices } })
  })
  expect(banners()).toHaveLength(1)
  await act(async () => {
    banners()[0].props.onDismiss()
  })
  expect(sendRequest).toHaveBeenCalledWith(
    'terminal.dismissGeneratedInputNotice',
    { id: 'refused' },
    undefined
  )
  expect(banners()).toHaveLength(1)
  act(() => {
    emit({ type: 'generatedInputNoticesChanged', notices: [] })
  })
  expect(banners()).toHaveLength(0)
  act(() => {
    mounted.unmount()
  })
})
