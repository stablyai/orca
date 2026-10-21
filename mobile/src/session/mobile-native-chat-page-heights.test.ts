import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatPageHeights } from './mobile-native-chat-page-heights'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

it('retires replaced source payloads without changing spacers or sweeping same-key content updates', () => {
  const cache = new MobileNativeChatPageHeights()
  const row = (id: string): NativeChatMessage => ({
    id,
    role: 'user',
    blocks: [],
    source: 'transcript',
    timestamp: 1
  })
  const keyOf = (m: NativeChatMessage) => m.id
  const state: MobileNativeChatTurnRow = {
    turnStatus: null,
    turnExpanded: false,
    activeTurnIsWorking: false,
    trailingRun: false,
    mayStillGrow: false,
    reasoningExpanded: false,
    onToggleReasoning: () => {},
    onToggleSubagentGroup: () => {},
    reasoningIsLive: false,
    userMessageOpen: false,
    onToggleUserMessage: () => {}
  }
  cache.remember('head', 80, row('head'), state, 'layout')
  cache.remember('retired', 20, row('retired'), state, 'layout')
  const before = ['head', 'retired', 'unknown']
  const source = cache.sourceKeys(['head', 'replacement', 'unknown'].map(row), keyOf, before)
  expect(source.changed).toBe(true)
  const slack = cache.px('retired')!
  const geometry = cache.spacers(source.keys, [0, 0], [0, 1], slack)
  cache.retain(source.keys)
  expect(cache.px('retired')).toBeUndefined()
  expect(cache.spacers(source.keys, [0, 0], [0, 1], slack)).toEqual(geometry)
  expect(cache.sourceKeys(source.keys.map(row), keyOf, source.keys).changed).toBe(false)
})
