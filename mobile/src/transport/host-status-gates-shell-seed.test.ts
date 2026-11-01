import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useHostStatusGates, type HostStatusGates } from './host-status-gates'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from './types'
import { RUNTIME_PROTOCOL_VERSION } from '../../../src/shared/protocol-version'

const SHELL_STATUS = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  capabilities: ['from-shell'],
  floatingWorkspaceEnabled: true
}

// A page's client carries the status its shell proved.
function pageClient() {
  return Object.assign(new FakeSession('connected'), { getShellHostStatus: () => SHELL_STATUS })
}

vi.mock('./host-app-version-store', () => ({ recordHostAppVersion: async () => undefined }))
vi.mock('./host-descriptor-recorder', () => ({ recordHostDescriptorFromStatus: () => {} }))

describe('a page gate its shell already proved', () => {
  it('opens on the shell status at once and takes its own read when it lands', async () => {
    let answer: (response: RpcResponse) => void = () => {}
    const client = pageClient()
    client.sendRequest.mockImplementation(
      () => new Promise<RpcResponse>((resolve) => (answer = resolve))
    )
    const seen: HostStatusGates[] = []
    function Probe(): null {
      seen.push(useHostStatusGates({ hostId: 'host-1', client, connState: 'connected' }))
      return null
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Probe))
    })

    expect(seen[0]).toMatchObject({
      statusPending: false,
      statusReadable: true,
      hostCapabilities: ['from-shell'],
      compatVerdict: { kind: 'ok' }
    })
    await act(async () => {
      answer({
        id: 'r',
        ok: true,
        result: { protocolVersion: 3, capabilities: ['from-page'] },
        _meta: { runtimeId: 'r' }
      })
    })
    expect(seen.at(-1)).toMatchObject({ statusPending: false, hostCapabilities: ['from-page'] })
    act(() => renderer?.unmount())
  })

  it('stops trusting the shell status once the connection drops before its own read lands', async () => {
    const client = pageClient()
    client.sendRequest.mockImplementation(() => new Promise<RpcResponse>(() => {}))
    let connState: 'connected' | 'reconnecting' = 'connected'
    const seen: HostStatusGates[] = []
    function Probe(): null {
      seen.push(useHostStatusGates({ hostId: 'host-1', client, connState }))
      return null
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    expect(seen.at(-1)).toMatchObject({ statusPending: false, hostCapabilities: ['from-shell'] })

    connState = 'reconnecting'
    await act(async () => renderer?.update(createElement(Probe)))
    connState = 'connected'
    await act(async () => renderer?.update(createElement(Probe)))

    expect(seen.at(-1)).toMatchObject({ statusPending: true, hostCapabilities: [] })
    act(() => renderer?.unmount())
  })
})
