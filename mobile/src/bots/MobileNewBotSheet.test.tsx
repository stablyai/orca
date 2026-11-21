import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const ops = vi.hoisted(() => ({ request: vi.fn(), interpret: vi.fn() }))
const reads = vi.hoisted(() => ({
  agents: new Map<unknown, string[]>(),
  readBotAgentChoices: vi.fn(),
  readSignedInEmail: vi.fn()
}))
vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    Platform: { OS: 'ios' },
    ActivityIndicator: 'ActivityIndicator',
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    Image: 'Image',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight', Shuffle: 'Shuffle' }))
vi.mock('./MobileBotTemplatesSheet', () => ({ MobileBotTemplatesSheet: 'TemplatesSheet' }))
vi.mock('./MobileBotImportSheet', () => ({ MobileBotImportSheet: 'ImportSheet' }))
vi.mock('./bot-import-host-reads', () => ({ useBotImportSources: () => ({ status: 'loading' }) }))
vi.mock('../components/bottom-drawer/BottomDrawer', () => ({
  BottomDrawer: ({ children }: { children?: ReactNode }) => children
}))
vi.mock('../components/composer-input/TextField', () => ({ TextField: 'TextField' }))
vi.mock('../components/sheets/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheet' }))
vi.mock('../components/list/ListGroup', () => ({ ListGroup: 'ListGroup', ListRow: 'ListRow' }))
vi.mock('../components/icons/HostKindIcon', () => ({ HostKindIcon: 'HostKindIcon' }))
vi.mock('../components/icons/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('../platform/haptics/haptics', () => ({ triggerError: vi.fn() }))
vi.mock('./bot-sheet-operations', () => ({ botCreate: ops }))
vi.mock('./MobileBotAvatar', () => ({ MobileBotAvatar: 'Avatar' }))
vi.mock('./new-bot-host-reads', () => reads)

import { MobileNewBotSheet } from './MobileNewBotSheet'

// Opaque clients: requests are mocked and only their identity is checked.
const desktop = { host: 'Studio Mac' }
const server = { host: 'linux 1' }
const COMPUTERS = [
  { id: 'local', hostId: 'local' as const, label: 'Studio Mac' },
  { id: 'runtime:linux-1', hostId: 'runtime:linux-1' as const, label: 'linux 1' }
]

function props(
  overrides: Partial<Parameters<typeof MobileNewBotSheet>[0]> = {}
): Parameters<typeof MobileNewBotSheet>[0] {
  return {
    visible: true,
    computerId: 'local',
    computers: COMPUTERS,
    botNamesOn: () => [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque clients; the request is mocked and only identity is checked.
    clientFor: (hostId) => (hostId === 'local' ? desktop : server) as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    pairedClientFor: () => desktop as never,
    onClose: vi.fn(),
    onCreated: vi.fn(),
    ...overrides
  }
}

async function mount(sheet: Parameters<typeof MobileNewBotSheet>[0]) {
  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(createElement(MobileNewBotSheet, sheet))
  })
  const all = (type: string) => renderer?.root.findAll((node) => node.type === type) ?? []
  const actionSheet = (title: string) => {
    const found = all('ActionSheet').find((node) => node.props.title === title)
    if (!found) {
      throw new Error(`no ${title} sheet`)
    }
    return found
  }
  const pick = async (title: string, id: string) => {
    await act(async () => {
      const action = actionSheet(title).props.actions.find(
        (entry: { id: string }) => entry.id === id
      )
      action.onPress()
    })
  }
  const submit = async (name: string) => {
    act(() => all('TextField')[0]?.props.onChangeText(name))
    await act(async () => {
      await all('TextField')[0]?.props.onSubmitEditing()
    })
  }
  return { renderer, all, actionSheet, pick, submit }
}

function resetHosts(agents: { desktop: string[]; server: string[] }) {
  ops.request.mockReset()
  ops.request.mockResolvedValue({})
  ops.interpret.mockReturnValue({ bot: { id: 'b9', name: 'Juno' } })
  reads.readBotAgentChoices.mockImplementation(async (client: unknown) =>
    client === desktop ? agents.desktop : agents.server
  )
  reads.readSignedInEmail.mockResolvedValue(null)
}

describe('New bot on the phone', () => {
  it('creates the bot on the computer Runs on picks, with an agent that computer has', async () => {
    resetHosts({ desktop: ['claude', 'codex'], server: ['opencode', 'claude'] })
    const onCreated = vi.fn()
    const sheet = await mount(props({ onCreated }))
    await sheet.pick('Agent', 'codex')
    await sheet.pick('Computer', 'runtime:linux-1')
    expect(sheet.actionSheet('Agent').props.actions).toMatchObject([
      { id: 'opencode', checked: true },
      { id: 'claude', checked: false }
    ])
    await sheet.pick('Agent', 'claude')
    await sheet.submit('  Juno ')
    expect(ops.request).toHaveBeenCalledWith(
      server,
      expect.objectContaining({
        name: 'Juno',
        agent: 'claude',
        avatar: expect.stringMatching(/^mascot:/)
      })
    )
    expect(onCreated).toHaveBeenCalledWith({ id: 'b9', name: 'Juno' }, COMPUTERS[1])
  })

  it('keeps Create off on a computer with none of the agents, or one it can no longer reach', async () => {
    resetHosts({ desktop: [], server: ['claude'] })
    const none = await mount(props())
    await none.submit('Juno')
    expect(ops.request).not.toHaveBeenCalled()

    const gone = await mount(props({ clientFor: () => null }))
    await gone.submit('Juno')
    expect(ops.request).not.toHaveBeenCalled()
  })

  it('says when the server runs on another Orca account than the paired computer', async () => {
    resetHosts({ desktop: ['claude'], server: ['claude'] })
    reads.readSignedInEmail.mockImplementation(async (client: unknown) =>
      client === desktop ? 'me@example.com' : 'ops@acme.dev'
    )
    const sheet = await mount(props({ computerId: 'runtime:linux-1' }))
    const lines = sheet.all('Text').map((node) => String(node.props.children))
    expect(lines.some((line) => line.includes('ops@acme.dev'))).toBe(true)
  })

  it('keeps Runs on and the draft when the chosen computer drops out', async () => {
    resetHosts({ desktop: ['claude'], server: ['claude'] })
    const sheet = await mount(props({ computerId: 'runtime:linux-1' }))
    act(() => sheet.all('TextField')[0]?.props.onChangeText('Juno'))
    await act(async () =>
      sheet.renderer?.update(
        createElement(
          MobileNewBotSheet,
          props({ computers: [COMPUTERS[0]], computerId: 'runtime:linux-1' })
        )
      )
    )
    const runsOn = sheet.all('ListRow').find((node) => node.props.title === 'Runs on')
    expect(runsOn?.props.accessibilityLabel).toBe('Runs on, linux 1')
    expect(sheet.all('TextField')[0]?.props.value).toBe('Juno')
    await sheet.pick('Computer', 'local')
    await sheet.submit('Juno')
    expect(ops.request).toHaveBeenCalledWith(desktop, expect.objectContaining({ name: 'Juno' }))
  })

  it('keeps Create off until the computer says which agents it has', async () => {
    resetHosts({ desktop: ['claude'], server: ['claude'] })
    let answer: (agents: string[]) => void = () => {}
    reads.readBotAgentChoices.mockImplementation(
      () => new Promise<string[]>((resolve) => (answer = resolve))
    )
    const sheet = await mount(props())
    await sheet.submit('Juno')
    expect(ops.request).not.toHaveBeenCalled()
    await act(async () => answer(['claude']))
    await sheet.submit('Juno')
    expect(ops.request).toHaveBeenCalledTimes(1)
  })

  it('never carries a template picked into the next New bot', async () => {
    resetHosts({ desktop: ['claude'], server: ['claude'] })
    const sheet = await mount(props())
    act(() =>
      sheet.all('TemplatesSheet')[0]?.props.onPick({
        origin: 'From the Support triage template',
        proposal: {
          name: 'Milo',
          purpose: 'Support',
          templateId: 'support',
          worktrees: [{ id: 'A-workspace', name: 'Support A' }]
        }
      })
    )
    expect(sheet.all('TextField')[0]?.props.value).toBe('Milo')
    // Cancel, then New bot again.
    await act(async () =>
      sheet.renderer?.update(createElement(MobileNewBotSheet, props({ visible: false })))
    )
    await act(async () => sheet.renderer?.update(createElement(MobileNewBotSheet, props())))
    expect(sheet.all('TextField')[0]?.props.value).toBe('')
    await sheet.submit('Juno')
    expect(ops.request.mock.calls[0]?.[1]).toEqual({
      name: 'Juno',
      agent: 'claude',
      avatar: expect.stringMatching(/^mascot:/)
    })
  })

  it('edits a bot’s offer on the computer its proposer runs on, and answers that card', async () => {
    resetHosts({ desktop: ['claude', 'codex'], server: ['claude'] })
    const sheet = await mount(
      props({
        computers: [COMPUTERS[0]],
        seed: {
          proposal: {
            name: 'Release',
            purpose: 'Tracks the release.',
            mascot: 'A1',
            worktrees: [{ id: 'w1', name: 'release-1.5' }]
          },
          agent: 'codex',
          fromOffer: { botId: 'atlas', offerId: 'o1' },
          origin: 'Proposed by Atlas'
        }
      })
    )
    const runsOn = sheet.all('ListRow').find((row) => row.props.title === 'Runs on')
    expect(runsOn?.props.navigates).toBe(false)
    expect(sheet.all('TextField')[0]?.props.value).toBe('Release')
    await act(async () => {
      await sheet.all('TextField')[0]?.props.onSubmitEditing()
    })
    expect(ops.request).toHaveBeenCalledWith(
      desktop,
      expect.objectContaining({
        name: 'Release',
        agent: 'codex',
        avatar: 'mascot:A1',
        handOff: [{ id: 'w1', name: 'release-1.5' }],
        fromOffer: { botId: 'atlas', offerId: 'o1' }
      })
    )
  })
})
