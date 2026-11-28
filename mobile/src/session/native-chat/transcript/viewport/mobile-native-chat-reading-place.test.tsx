import { createElement, Fragment } from 'react'
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestRendererJSON
} from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { MobileNativeChatRowContent } from '../projection/MobileNativeChatRowItemSource'
import {
  mobileNativeChatReadingDrift,
  mobileNativeChatReadingPlace,
  mobileNativeChatRowBoxProps,
  mobileNativeChatRowId,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'

vi.mock('react-native', () => ({ View: 'View', StyleSheet: { create: (x: unknown) => x } }))
vi.mock('../tool-results/MobileNativeChatTurnDiffRollup', () => ({
  MobileNativeChatTurnDiffRollup: () => null
}))
vi.mock('../messages/MobileNativeChatWorkerApprovalReceipts', () => ({
  MobileNativeChatWorkerApprovalReceipts: () => null
}))
// The message draws its turn status line beside its own tagged row, as the real one does.
vi.mock('../messages/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: ({ message, rowKey }: { message: NativeChatMessage; rowKey?: string }) =>
    createElement(
      Fragment,
      null,
      createElement('View', { testID: 'turn-status' }),
      createElement('View', { testID: mobileNativeChatRowId(rowKey ?? message.id) })
    )
}))

type FakeRow = NonNullable<ReturnType<MobileNativeChatScrollNode['querySelector']>>

const VIEW = 200
const keys = { current: (key: string) => key, placement: () => 'row' }

function drawnRow(key: string): ReactTestRendererJSON[] {
  const message: NativeChatMessage = {
    id: `message-${key}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: key }],
    timestamp: null,
    source: 'transcript'
  }
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      <MobileNativeChatRowContent
        message={message}
        rowKey={key}
        scope="scope"
        activityJoin="both"
        source={null}
      />
    )
  })
  const json = renderer?.toJSON() ?? null
  act(() => renderer?.unmount())
  return json === null ? [] : Array.isArray(json) ? json : [json]
}

// An end-anchored page whose row box holds what the real rows render, each drawn node `heights[at]` tall.
function page(drawn: ReactTestRendererJSON[], heights: number[]) {
  const startOf = (at: number) => heights.slice(0, at).reduce((sum, height) => sum + height, 0)
  const scroller = {
    scrollTop: 0,
    clientHeight: VIEW,
    get scrollHeight() {
      return Math.max(VIEW, startOf(heights.length))
    },
    getBoundingClientRect: () => ({ top: 0, bottom: VIEW }),
    getAttribute: () => null,
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector === `[${Object.keys(mobileNativeChatRowBoxProps)[0]}]` ? box : null
  }
  const viewTop = () => scroller.scrollHeight - VIEW + scroller.scrollTop
  const node = (testId: unknown, at: number, children: FakeRow[] = []): FakeRow => ({
    getBoundingClientRect: () => ({
      top: startOf(at) - viewTop(),
      bottom: startOf(at + 1) - viewTop()
    }),
    getAttribute: (name) => (name === 'data-testid' && typeof testId === 'string' ? testId : null),
    querySelectorAll: () => [],
    nextElementSibling: null,
    children
  })
  const box = node(
    null,
    0,
    drawn.map((json, at) => node(json.props.testID, at))
  )
  return scroller satisfies MobileNativeChatScrollNode
}

it('holds a parked place on the rows MobileNativeChatRowContent draws while the reply grows', () => {
  const drawn = ['r0', 'r1', 'r2', 'r3'].flatMap(drawnRow)
  expect(drawn).toHaveLength(4)
  const heights = drawn.map(() => 150)
  const view = page(drawn, heights)
  view.scrollTop = -250
  const place = mobileNativeChatReadingPlace(view, keys)
  expect(place[0]).toMatchObject({ key: 'r1', top: 0 })

  heights[3] = 270
  expect(mobileNativeChatReadingDrift(place, view, keys)).toBe(-120)
})
