import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileNativeChatPageHistory } from './use-mobile-native-chat-page-history'

const platform = vi.hoisted(() => ({ OS: 'web' }))

vi.mock('react-native', () => ({ Platform: platform }))

type Item = { id: string }
type History = ReturnType<typeof useMobileNativeChatPageHistory<Item>>

const rows = (...ids: string[]): Item[] => ids.map((id) => ({ id }))
const renderRow = vi.fn(({ item, index }: { item: Item; index: number }): ReactElement =>
  createElement('Row', { id: item.id, index })
)

describe('useMobileNativeChatPageHistory', () => {
  let renderer: ReactTestRenderer | null = null
  let history: History | null = null

  function Harness({ items }: { items: Item[] }): null {
    history = useMobileNativeChatPageHistory(items, renderRow, 'chat')
    return null
  }

  async function show(items: Item[]): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Harness, { items }))
      } else {
        renderer = create(createElement(Harness, { items }))
      }
    })
  }

  /** What the list header draws below the control it was given. */
  function headerRows(): { id: string; index: number }[] {
    const drawn: { header?: ReactTestRenderer } = {}
    act(() => {
      drawn.header = create(
        createElement('Header', null, history?.withHistory(createElement('Control')))
      )
    })
    const found = drawn.header?.root.findAll((node) => typeof node.props.index === 'number') ?? []
    return found.map((row) => ({ id: row.props.id, index: row.props.index }))
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    history = null
    platform.OS = 'web'
  })

  it('draws history that loads above the list in its header, leaving the list its rows', async () => {
    await show(rows('a', 'b'))
    expect(history?.listRows).toEqual(rows('a', 'b'))
    expect(headerRows()).toEqual([])

    await show(rows('x', 'y', 'a', 'b'))

    // RN Web's list draws by index: handing it the new rows would redraw a different set.
    expect(history?.listRows).toEqual(rows('a', 'b'))
    expect(headerRows()).toEqual([
      { id: 'x', index: 0 },
      { id: 'y', index: 1 }
    ])
    // The list's first row is the third row of the chat, and is drawn as that.
    history?.renderListRow({ item: { id: 'a' }, index: 0 })
    expect(renderRow).toHaveBeenLastCalledWith({ item: { id: 'a' }, index: 2 })
  })

  it('gives the list every row again once the row it started at is gone', async () => {
    await show(rows('a', 'b'))
    await show(rows('x', 'a', 'b'))

    await show(rows('p', 'q'))

    expect(history?.listRows).toEqual(rows('p', 'q'))
    expect(headerRows()).toEqual([])
  })

  it('leaves a native list all its rows: it holds its own place', async () => {
    platform.OS = 'ios'
    await show(rows('a', 'b'))
    const all = rows('x', 'y', 'a', 'b')

    await show(all)

    expect(history?.listRows).toBe(all)
    expect(history?.renderListRow).toBe(renderRow)
    expect(headerRows()).toEqual([])
  })
})
