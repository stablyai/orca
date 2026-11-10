import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { MobileJiraConnection } from './jira-mobile-connection'
import { useMobileJiraConnectionState } from './use-mobile-jira-connection-state'

type PairedDesktopClient = { id: string }
const createClient = (): PairedDesktopClient => ({ id: 'paired-desktop' })

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) {
      renderer.unmount()
    }
  })
})

function mountConnection(client: PairedDesktopClient) {
  let value: ReturnType<typeof useMobileJiraConnectionState> | undefined
  function Probe(props: { client: PairedDesktopClient; state: string }) {
    value = useMobileJiraConnectionState(props.client, props.state)
    return null
  }
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(createElement(Probe, { client, state: 'connected' }))
    mounted.push(renderer)
  })
  return {
    current() {
      if (!value) {
        throw new Error('Connection did not render')
      }
      return value
    },
    update(nextClient: PairedDesktopClient, state = 'connected') {
      act(() => {
        renderer?.update(createElement(Probe, { client: nextClient, state }))
      })
    }
  }
}

const connected: MobileJiraConnection = {
  connected: true,
  sites: [],
  selection: 'all',
  credentialError: null,
  unavailableReason: null
}

describe('mobile Jira connection session ownership', () => {
  it('discards the previous connection on a host switch before another status arrives', () => {
    const fixture = mountConnection(createClient())
    act(() => fixture.current()[1](connected))
    fixture.update(createClient())
    expect(fixture.current()[0]).toMatchObject({ connected: false, selection: null })
  })

  it('retires old setters even after switching back to the same client', () => {
    const client = createClient()
    const fixture = mountConnection(client)
    const oldSet = fixture.current()[1]
    fixture.update(createClient())
    fixture.update(client)
    act(() => fixture.current()[1](connected))
    act(() => oldSet({ ...connected, connected: false }))
    expect(fixture.current()[0].connected).toBe(true)
  })

  it('requires fresh status after disconnecting and reconnecting the same client', () => {
    const client = createClient()
    const fixture = mountConnection(client)
    const oldSet = fixture.current()[1]
    act(() => oldSet(connected))
    fixture.update(client, 'disconnected')
    fixture.update(client)
    act(() => oldSet(connected))
    expect(fixture.current()[0]).toMatchObject({ connected: false, selection: null })
  })
})
