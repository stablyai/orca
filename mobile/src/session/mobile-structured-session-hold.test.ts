import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSessionHold } from './mobile-structured-session-hold'

function renderHold(props: { client: RpcClient | null; sessionId: string | null }): {
  renderer: ReactTestRenderer
} {
  function Probe(): null {
    useMobileStructuredSessionHold(props)
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe))
  })
  return { renderer }
}

function client(sendRequest: ReturnType<typeof vi.fn>): RpcClient {
  return { sendRequest } as unknown as RpcClient
}

let rendered: ReactTestRenderer | null = null

afterEach(() => {
  act(() => rendered?.unmount())
  rendered = null
})

describe('a paired session view', () => {
  it('holds the session while it is open and releases it when it closes', async () => {
    const sendRequest = vi.fn(async () => ({ ok: true, result: {} }))
    const { renderer } = renderHold({ client: client(sendRequest), sessionId: 'session-alpha' })

    const hold = sendRequest.mock.calls.find(([method]) => method === 'agentSession.hold')
    expect(hold?.[1]).toMatchObject({ sessionId: 'session-alpha' })

    await act(async () => renderer.unmount())

    const release = sendRequest.mock.calls.find(([method]) => method === 'agentSession.release')
    expect(release?.[1]).toEqual(hold?.[1])
  })

  it('asks for nothing before there is a session to hold', () => {
    const sendRequest = vi.fn(async () => ({ ok: true, result: {} }))
    rendered = renderHold({ client: client(sendRequest), sessionId: null }).renderer

    expect(sendRequest).not.toHaveBeenCalled()
  })

  // An older host answers method_not_found; a chat that cannot be held is still a chat that reads.
  it('survives a host that does not know the method', () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('method_not_found')
    })

    expect(() => {
      rendered = renderHold({ client: client(sendRequest), sessionId: 'session-alpha' }).renderer
    }).not.toThrow()
  })
})
