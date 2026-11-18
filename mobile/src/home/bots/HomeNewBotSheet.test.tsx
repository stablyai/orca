import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { HomeBots } from './home-bot-rows'

vi.mock('../../bots/MobileNewBotSheet', () => ({ MobileNewBotSheet: 'NewBotSheet' }))
vi.mock('../../bots/use-open-bot-home', () => ({
  botPlaceClient: () => null,
  useOpenBotHome: () => () => {}
}))

import { HomeNewBotSheet } from './HomeNewBotSheet'

const BOTS: HomeBots = {
  rows: [],
  needsYou: 0,
  computers: [],
  labels: new Map(),
  unavailable: [],
  listable: false,
  awaiting: false,
  activityByHost: new Map()
}

function sheetProps(visible: boolean) {
  return { visible, bots: BOTS, clientOf: () => null, onClose: () => {} }
}

describe('Home’s New bot sheet', () => {
  it('mounts nothing until opened, and stays until its drawer has closed', () => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(createElement(HomeNewBotSheet, sheetProps(false)))
    })
    const sheets = () => tree.root.findAll((node) => String(node.type) === 'NewBotSheet')
    expect(sheets()).toHaveLength(0)
    act(() => tree.update(createElement(HomeNewBotSheet, sheetProps(true))))
    expect(sheets()).toHaveLength(1)
    act(() => tree.update(createElement(HomeNewBotSheet, sheetProps(false))))
    expect(sheets()).toHaveLength(1)
    act(() => sheets()[0]?.props.onAfterClose())
    expect(sheets()).toHaveLength(0)
  })
})
