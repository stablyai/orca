import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ComposedGesture } from 'react-native-gesture-handler'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'
import { MobileNativeChatRowList } from './MobileNativeChatRowList'

const platform = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('react-native', () => ({
  FlatList: (props: { renderScrollComponent?: (scrollProps: object) => ReactNode }) =>
    createElement('FlatList', null, props.renderScrollComponent?.({})),
  Platform: platform,
  ScrollView: 'ScrollView',
  View: 'View'
}))
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: 'GestureDetector'
}))
vi.mock('../../MobileNativeChatPageList', () => ({
  MobileNativeChatPageList: 'PageList'
}))

// SAFETY: the list only forwards this object into GestureDetector.
const pinchGesture = { marker: 'pinch' } as unknown as ComposedGesture

const tail = {
  listProps: { ref: () => {} },
  pageListProps: {
    ref: () => {},
    isFollowing: () => true,
    onEndDistance: () => {}
  },
  showJumpToTail: false,
  pinToTail: () => {},
  pinToTailAfterContentResize: () => {},
  jumpToTail: () => {},
  beginUserScroll: () => {},
  endUserDrag: () => {},
  beginMomentum: () => {},
  endMomentum: () => {},
  scrollMayLoadEarlier: () => false,
  recordScrollMetrics: () => {}
}

function renderList() {
  let renderer: ReturnType<typeof create> | null = null
  act(() => {
    renderer = create(
      createElement(MobileNativeChatRowList, {
        tail,
        rowKeys: {
          scope: 'tab',
          sourceHead: undefined,
          keyOf: () => 'row',
          current: () => undefined,
          placement: () => 'row'
        },
        rows: [],
        renderItem: () => createElement('Row'),
        hasHeader: false,
        pinchGesture,
        layoutKey: '1',
        contentContainerStyle: null,
        header: null,
        footer: null,
        emptyStateView: null,
        onScroll: () => {}
      })
    )
  })
  return renderer!
}

describe('MobileNativeChatRowList pinch', () => {
  it('attaches the pinch to the native scroll view', () => {
    platform.OS = 'ios'
    const scroll = findByHostType(renderList().root, 'ScrollView')
    expect(scroll.props.collapsable).toBe(false)
    expect(scroll.parent?.type).toBe('GestureDetector')
    expect(scroll.parent?.props.gesture).toBe(pinchGesture)
  })

  it('leaves the web list on the page scroller', () => {
    platform.OS = 'web'
    const root = renderList().root
    expect(findAllByHostType(root, 'ScrollView')).toEqual([])
    expect(findByHostType(root, 'PageList')).toBeTruthy()
  })
})
