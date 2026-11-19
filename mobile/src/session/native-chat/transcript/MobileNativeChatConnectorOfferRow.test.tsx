import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const store = vi.hoisted((): { bot: unknown } => ({ bot: null }))
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Platform: { OS: 'ios' },
    Text: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ Check: 'Check' }))
vi.mock('../../../bots/MobileConnectorSourceIcon', () => ({
  MobileConnectorSourceIcon: 'Icon',
  MobileGoogleMark: 'GoogleMark'
}))
vi.mock('../../../bots/host-bot-store', () => ({ useHostBotById: () => store.bot }))

import type {
  ConnectorOffer,
  ConnectorOfferSource
} from '../../../../../src/shared/bots/bot-connector-offer'
import { MobileNativeChatConnectorOfferRow } from './MobileNativeChatConnectorOfferRow'

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

function render(
  offer: ConnectorOffer & { source: ConnectorOfferSource } = {
    botId: 'b1',
    source: 'slack',
    workspace: 'Globex'
  }
): string {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      createElement(MobileNativeChatConnectorOfferRow, {
        offer,
        fontScale: 1
      })
    )
  })
  return renderer ? textOf(renderer.root) : ''
}

describe('a Connect card on the phone', () => {
  it('reads Google as connected only once the owner turned it on for the bot', () => {
    store.bot = { google: false }
    expect(render({ botId: 'b1', source: 'google' })).not.toContain('Connected')
    store.bot = { google: true }
    expect(render({ botId: 'b1', source: 'google' })).toContain('Connected')
  })

  // A bot already on Slack, asking for another workspace, isn't connected to that one yet.
  it('says Connected for a named workspace only once the bot is in it', () => {
    store.bot = { slack: { teamId: 'T1' } }
    expect(render()).toContain('Connect it in Orca on your computer')
    const link = (workspaceName: string) => ({ workspaceName })
    store.bot = { linear: link('Globex'), linearWorkspaces: [link('Globex'), link('Acme')] }
    expect(render({ botId: 'b1', source: 'linear', workspace: 'acme' })).toContain('Connected')
    expect(render({ botId: 'b1', source: 'linear', workspace: 'Other' })).toContain(
      'Connect it in Orca on your computer'
    )
  })
})
