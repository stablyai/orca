import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { HomeBotRow } from './bots/home-bot-rows'

vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('./bots/MobileHomeBotRow', () => ({ MobileHomeBotRows: 'BotRows' }))
vi.mock('./MobileHomeSectionHeading', () => ({ MobileHomeSectionHeading: 'Heading' }))

import { MobileHomeBots } from './MobileHomeBots'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row component is mocked; the section reads only key.
const row = (name: string) => ({ key: name, title: name }) as unknown as HomeBotRow

function render(rows: HomeBotRow[], onSeeAll = () => {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(MobileHomeBots, { rows, onOpen: () => {}, onSeeAll }))
  })
  return renderer
}

const shown = (section: ReactTestRenderer) =>
  section.root
    .find((node) => String(node.type) === 'BotRows')
    .props.rows.map((entry: HomeBotRow) => entry.title)
const heading = (section: ReactTestRenderer) =>
  section.root.find((node) => String(node.type) === 'Heading').props

describe('Feed’s Bots section', () => {
  it('is hidden when no bots can be listed', () => {
    expect(render([]).toJSON()).toBeNull()
  })

  it('lists up to three bots with no link when that is all of them', () => {
    const section = render([row('Bot builder'), row('Atlas'), row('ux-designer')])
    expect(shown(section)).toEqual(['Bot builder', 'Atlas', 'ux-designer'])
    expect(heading(section)).toMatchObject({ count: 3, aside: undefined })
  })

  it('shows the first three and links to the tab when there are more', () => {
    const onSeeAll = vi.fn()
    const section = render([row('A'), row('B'), row('C'), row('D')], onSeeAll)
    expect(shown(section)).toEqual(['A', 'B', 'C'])
    expect(heading(section)).toMatchObject({ count: 4, aside: 'See all bots' })
    heading(section).onAsidePress()
    expect(onSeeAll).toHaveBeenCalledTimes(1)
  })
})
