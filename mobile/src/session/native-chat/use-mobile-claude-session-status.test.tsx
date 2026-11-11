import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeSessionStatus } from '../../../../src/shared/native-chat/claude-session-status'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { rpcRefusal, rpcSuccess } from '../../transport/rpc/rpc-operation-test-families'
import { useMobileClaudeSessionStatus } from './use-mobile-claude-session-status'

const STATUS: ClaudeSessionStatus = {
  model: 'claude-opus-5-5',
  effort: 'high',
  usedTokens: 340000,
  windowTokens: 1000000,
  compactions: 2
}

type Reply = ReturnType<typeof rpcSuccess>
type HookArgs = Parameters<typeof useMobileClaudeSessionStatus>[0]

let renderer: ReactTestRenderer | null = null
let latest: ClaudeSessionStatus | null = null

function clientWith(reply: (sessionId: string) => Reply | Promise<Reply>) {
  const sendRequest = vi.fn(async (_method: string, params: unknown) =>
    reply((params as { sessionId: string }).sessionId)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only sendRequest.
  return { client: { sendRequest } as unknown as RpcClient, sendRequest }
}

function Harness(props: HookArgs): null {
  latest = useMobileClaudeSessionStatus(props)
  return null
}

const args = (client: RpcClient, overrides: Partial<HookArgs> = {}): HookArgs => ({
  client,
  agent: 'claude',
  sessionId: 'a',
  refreshKey: 'r0',
  enabled: true,
  ...overrides
})

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function mount(props: HookArgs): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Harness, props))
  })
  await flush()
}

async function update(props: HookArgs): Promise<void> {
  await act(async () => {
    renderer?.update(createElement(Harness, props))
  })
  await flush()
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  latest = null
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.useRealTimers()
})

it('reports the status of the open chat', async () => {
  const { client } = clientWith(() => rpcSuccess({ status: STATUS }))
  await mount(args(client))
  expect(latest).toEqual(STATUS)
})

it('asks nothing while disabled', async () => {
  const { client, sendRequest } = clientWith(() => rpcSuccess({ status: STATUS }))
  await mount(args(client, { enabled: false }))
  expect(sendRequest).not.toHaveBeenCalled()
  expect(latest).toBeNull()
})

it('stays null and stops asking when the host lacks the method', async () => {
  const { client, sendRequest } = clientWith(() => rpcRefusal('method_not_found'))
  await mount(args(client))
  await update(args(client, { refreshKey: 'r1' }))
  await advance(120_000)
  expect(latest).toBeNull()
  expect(sendRequest).toHaveBeenCalledTimes(1)
})

it('keeps asking after an ordinary failure', async () => {
  const { client, sendRequest } = clientWith(() => rpcRefusal('internal_error'))
  await mount(args(client))
  await advance(30_000)
  expect(sendRequest).toHaveBeenCalledTimes(2)
})

it('drops an answer that arrives after the chat changed', async () => {
  let answerA: (reply: Reply) => void = () => {}
  const { client } = clientWith((sessionId) =>
    sessionId === 'a'
      ? new Promise<Reply>((resolve) => {
          answerA = resolve
        })
      : rpcSuccess({ status: { ...STATUS, compactions: 7 } })
  )
  await mount(args(client))
  await update(args(client, { sessionId: 'b' }))
  await act(async () => {
    answerA(rpcSuccess({ status: STATUS }))
  })
  await flush()
  expect(latest?.compactions).toBe(7)
})

it('does not show the previous chat while the new one loads', async () => {
  const { client } = clientWith((sessionId) =>
    sessionId === 'a' ? rpcSuccess({ status: STATUS }) : new Promise<Reply>(() => {})
  )
  await mount(args(client))
  expect(latest).toEqual(STATUS)
  await update(args(client, { sessionId: 'b' }))
  expect(latest).toBeNull()
})

it('asks once for a burst of chat updates', async () => {
  const { client, sendRequest } = clientWith(() => rpcSuccess({ status: STATUS }))
  await mount(args(client))
  expect(sendRequest).toHaveBeenCalledTimes(1)
  await update(args(client, { refreshKey: 'r1' }))
  await advance(400)
  await update(args(client, { refreshKey: 'r2' }))
  await advance(1_000)
  expect(sendRequest).toHaveBeenCalledTimes(2)
})

it('keeps the last status through a failed refresh', async () => {
  const replies: Reply[] = [rpcSuccess({ status: STATUS }), rpcRefusal('internal_error')]
  const { client } = clientWith(() => replies.shift() ?? rpcRefusal('internal_error'))
  await mount(args(client))
  await advance(30_000)
  expect(latest).toEqual(STATUS)
})
