import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { HomeBotRow, HomeBotsUnavailable } from '../bots/home-bot-rows'
import type { MobileHomeData } from '../use-mobile-home-data'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('lucide-react-native', () => ({ Bot: 'BotIcon', Plus: 'PlusIcon' }))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, contentMaxWidth: 600 })
}))
vi.mock('../../bots/MobileBotsSectionHeader', () => ({ MobileBotsListEnd: 'ListEnd' }))
vi.mock('../bots/MobileHomeBotRow', () => ({ MobileHomeBotRows: 'BotRows' }))
vi.mock('./MobileHomeTabEmpty', () => ({ MobileHomeTabEmpty: 'TabEmpty' }))
vi.mock('./MobileHomeTabHeader', () => ({
  MobileHomeTabHeader: 'Header',
  MobileHomeTabHeaderButton: 'HeaderButton'
}))

import { homeBotsNotice, MobileHomeBotsTab } from './MobileHomeBotsTab'

const studio = { id: 'studio', name: 'Studio Mac' }

function data(overrides: Record<string, unknown>): MobileHomeData {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tab reads only these fields of Home's data.
  return {
    hostCatalogLoaded: true,
    hostCatalog: [studio],
    connectedHosts: [studio],
    hostsConnecting: false,
    botsByHost: { studio: [] },
    bots: {
      rows: [],
      needsYou: 0,
      computers: [],
      labels: new Map(),
      unavailable: [],
      listable: true,
      awaiting: false
    },
    ...overrides
  } as unknown as MobileHomeData
}

function render(home: MobileHomeData, onNewBot?: () => void): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(MobileHomeBotsTab, {
        data: home,
        bottomInset: 0,
        onNewBot,
        onOpenBot: () => {}
      })
    )
  })
  return renderer
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row component is mocked; the tab reads only key.
const row = (name: string) => ({ key: name, title: name }) as unknown as HomeBotRow

describe('Bots tab', () => {
  it('asks to pair a desktop when none is paired, with no New bot', () => {
    const tab = render(data({ hostCatalog: [], connectedHosts: [] }))
    expect(tab.root.findAll((node) => String(node.type) === 'TabEmpty')).toHaveLength(1)
    expect(tab.root.find((node) => String(node.type) === 'Header').props.trailing).toBeUndefined()
  })

  it('waits for a connected computer’s first answer', () => {
    const tab = render(
      data({
        bots: {
          rows: [],
          needsYou: 0,
          computers: [],
          labels: new Map(),
          unavailable: [],
          listable: false,
          awaiting: true
        }
      })
    )
    expect(tab.root.findAll((node) => String(node.type) === 'ActivityIndicator')).toHaveLength(1)
    expect(tab.root.findAll((node) => String(node.type) === 'ListEnd')).toHaveLength(0)
  })

  it('says no bots yet once every computer answered with none', () => {
    const tab = render(data({}))
    expect(tab.root.findAll((node) => String(node.type) === 'ListEnd')).toHaveLength(1)
  })

  it('lists the rows in the order given, with New bot when a computer takes one', () => {
    const tab = render(
      data({
        bots: {
          rows: [row('Bot builder'), row('Atlas')],
          needsYou: 0,
          unavailable: [],
          listable: true,
          awaiting: false
        }
      }),
      () => {}
    )
    const list = tab.root.find((node) => String(node.type) === 'BotRows')
    expect(list.props.rows.map((entry: HomeBotRow) => entry.title)).toEqual([
      'Bot builder',
      'Atlas'
    ])
    expect(tab.root.find((node) => String(node.type) === 'Header').props.trailing).toBeTruthy()
  })
})

const why = (label: string, reason: HomeBotsUnavailable['reason'], desktopLabel?: string) => ({
  key: label,
  label,
  reason,
  ...(desktopLabel ? { desktopLabel } : {})
})
const notice = (
  unavailable: HomeBotsUnavailable[],
  extra: { rows?: HomeBotRow[]; listable?: boolean; canCreate?: boolean } = {}
) =>
  homeBotsNotice(
    { rows: extra.rows ?? [], unavailable, listable: extra.listable ?? false, awaiting: false },
    extra.canCreate ?? false
  )

describe('Bots tab when bots are unavailable', () => {
  it('names the one computer too old to list bots', () => {
    expect(notice([why('Studio Mac', 'update')])).toEqual({
      kind: 'empty',
      title: 'Update Orca on Studio Mac',
      message: 'Its version of Orca can’t show bots on your phone yet.'
    })
  })

  it('speaks of every computer when two share a name', () => {
    expect(
      notice([
        { key: 'a', label: 'Mac', reason: 'update' },
        { key: 'b', label: 'Mac', reason: 'update' }
      ])
    ).toMatchObject({ kind: 'empty', title: 'Update Orca on your computers' })
  })

  it('points a server’s switch to its paired computer’s Settings', () => {
    expect(notice([why('build-box', 'off', 'Studio Mac')])).toEqual({
      kind: 'empty',
      title: 'Bots are off on build-box',
      message:
        'To turn them on, open Orca on Studio Mac and go to Settings › Bots › Enable bots on build-box.'
    })
  })

  it('lists what it can, then a line per computer it can’t, and why + is gone', () => {
    const lines = notice(
      [why('build-box', 'off'), why('MacBook Air', 'update'), why('Studio Mac', 'no-create')],
      { rows: [row('Bot builder')], listable: true }
    )
    expect(lines).toEqual({
      kind: 'lines',
      lines: [
        { key: 'off:build-box', text: 'Bots are off on build-box.' },
        { key: 'update:MacBook Air', text: 'Update Orca on MacBook Air to see its bots.' },
        {
          key: 'no-create:Studio Mac',
          text: 'Update Orca on Studio Mac to make bots from your phone.'
        }
      ]
    })
  })
})
