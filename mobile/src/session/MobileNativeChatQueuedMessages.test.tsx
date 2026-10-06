import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionQueuePause } from '../../../src/shared/agent-session-wire'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'
import type { MobileQueuedMessageCard } from './mobile-structured-queued-message-cards'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  AlertCircle: 'AlertCircle',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Pause: 'Pause',
  Pencil: 'Pencil',
  Play: 'Play',
  Send: 'Send',
  Trash2: 'Trash2'
}))

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))

function card(
  overrides: Partial<MobileQueuedMessageCard> & { messageId: string }
): MobileQueuedMessageCard {
  return {
    text: `text of ${overrides.messageId}`,
    state: 'waiting',
    paused: false,
    needsAttention: false,
    caption: null,
    ...overrides
  }
}

describe('MobileNativeChatQueuedMessages', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function mount(
    props: Parameters<typeof MobileNativeChatQueuedMessages>[0]
  ): Promise<ReactTestRenderer> {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(createElement(MobileNativeChatQueuedMessages, props))
    })
    return mounted
  }

  function texts(mounted: ReactTestRenderer): unknown[] {
    return mounted.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
  }

  function nodeTypes(root: ReactTestRenderer['root']): string[] {
    return root.findAll((node) => typeof node.type === 'string').map((node) => String(node.type))
  }

  function flatStyle(style: unknown): Record<string, unknown> {
    return Object.assign({}, ...[style].flat())
  }

  function sheet(mounted: ReactTestRenderer) {
    return mounted.root.find((node) => String(node.type) === 'ActionSheetModal')
  }

  it('draws a plain waiting card as one compact row with no caption', async () => {
    const mounted = await mount({ cards: [card({ messageId: 'w', text: 'next' })] })
    const rows = mounted.root.findAllByProps({ testID: 'queued-card-row' })
    expect(rows).toHaveLength(1)
    expect(texts(mounted)).toEqual(['next', 'Steer'])
    // At most two lines: the row has no hover title to read the rest from.
    expect(
      mounted.root.find((node) => String(node.type) === 'Text' && node.props.children === 'next')
        .props.numberOfLines
    ).toBe(2)
    expect(nodeTypes(rows[0]!)).toContain('ListEnd')
    expect(nodeTypes(rows[0]!)).not.toContain('AlertCircle')
  })

  it('divides rows with hairlines inside one box, the first row undivided', async () => {
    const mounted = await mount({ cards: [card({ messageId: 'a' }), card({ messageId: 'b' })] })
    const rows = mounted.root.findAllByProps({ testID: 'queued-card-row' })
    expect(rows.map((row) => Boolean(flatStyle(row.props.style).borderTopWidth))).toEqual([
      false,
      true
    ])
  })

  it('captions a hold under the text on one muted line', async () => {
    const mounted = await mount({
      cards: [card({ messageId: 'b', caption: 'Waiting — a message ahead needs attention' })]
    })
    const caption = mounted.root.find(
      (node) =>
        String(node.type) === 'Text' &&
        node.props.children === 'Waiting — a message ahead needs attention'
    )
    expect(caption.props.numberOfLines).toBe(1)
    expect(flatStyle(caption.props.style).color).not.toBe('#ef4444')
  })

  it("lets a returned card's reason wrap whole, in the destructive color, beside an alert", async () => {
    const reason =
      'The provider did not accept this message: Claude does not support the image type .bmp in a steering message.'
    const mounted = await mount({
      cards: [
        card({ messageId: 'r', state: 'returned', needsAttention: true, caption: reason }),
        card({ messageId: 'w' })
      ]
    })
    const caption = mounted.root.find(
      (node) => String(node.type) === 'Text' && node.props.children === reason
    )
    expect(caption.props.numberOfLines).toBeUndefined()
    expect(flatStyle(caption.props.style).color).toBe('#ef4444')
    const [returnedRow, waitingRow] = mounted.root.findAllByProps({ testID: 'queued-card-row' })
    expect(nodeTypes(returnedRow!)).toContain('AlertCircle')
    expect(nodeTypes(waitingRow!)).not.toContain('AlertCircle')
  })

  it('reads Steer on a waiting card and plain Send on a returned one or one whose own send failed', async () => {
    const mounted = await mount({
      cards: [
        card({ messageId: 'failed', paused: true, needsAttention: true }),
        card({ messageId: 'waiting' }),
        card({ messageId: 'returned', state: 'returned', needsAttention: true })
      ],
      onSend: vi.fn(async () => true)
    })
    expect(mounted.root.findByProps({ accessibilityLabel: 'Send this message' })).toBeTruthy()
    expect(
      mounted.root.findByProps({ accessibilityLabel: 'Submit without interrupting the model' })
    ).toBeTruthy()
    expect(mounted.root.findByProps({ accessibilityLabel: 'Send this message again' })).toBeTruthy()
    expect(texts(mounted).filter((text) => text === 'Send' || text === 'Steer')).toEqual([
      'Send',
      'Steer',
      'Send'
    ])
    const rows = mounted.root.findAllByProps({ testID: 'queued-card-row' })
    expect(nodeTypes(rows[0]!)).toContain('Send')
    expect(nodeTypes(rows[1]!)).toContain('CornerDownRight')
  })

  it("holds Steer while a person's Stop ends the turn; Delete still works", async () => {
    const onSend = vi.fn(async () => true)
    const onDelete = vi.fn(async () => true)
    const mounted = await mount({
      cards: [card({ messageId: 'w' })],
      onSend,
      onDelete,
      steerHeld: true
    })
    const steer = mounted.root.findByProps({
      accessibilityLabel: 'Submit without interrupting the model'
    })
    expect(steer.props.disabled).toBe(true)
    expect(steer.props.accessibilityState).toEqual({ disabled: true })
    const trash = mounted.root.findByProps({ accessibilityLabel: 'Delete this queued message' })
    await act(async () => trash.props.onPress())
    expect(onDelete).toHaveBeenCalledWith('w')
  })

  it('deletes a card from its trash button', async () => {
    const onDelete = vi.fn(async () => true)
    const mounted = await mount({ cards: [card({ messageId: 'w' })], onDelete })
    const trash = mounted.root.find(
      (node) =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Delete this queued message'
    )
    expect(nodeTypes(trash)).toContain('Trash2')
    await act(async () => trash.props.onPress())
    expect(onDelete).toHaveBeenCalledWith('w')
  })

  it('opens the card menu from "…", whose Edit message edits that card once the sheet is gone', async () => {
    const onEdit = vi.fn(async () => true)
    const mounted = await mount({
      cards: [card({ messageId: 'a' }), card({ messageId: 'b', text: 'fix me' })],
      onEdit
    })
    expect(sheet(mounted).props.visible).toBe(false)
    const more = mounted.root.findAllByProps({ accessibilityLabel: 'More actions' })
    expect(more).toHaveLength(2)
    await act(async () => more[1]!.props.onPress())
    expect(sheet(mounted).props.visible).toBe(true)
    expect(sheet(mounted).props.title).toBe('fix me')
    const actions: ActionSheetAction[] = sheet(mounted).props.actions
    expect(actions.map((action) => action.label)).toEqual(['Edit message'])
    // Focus can only move to the composer once iOS has dismissed the sheet's Modal.
    expect(actions[0]!.closeBeforePress).toBe(true)
    await act(async () => actions[0]!.onPress())
    expect(onEdit).toHaveBeenCalledWith('b')
    await act(async () => sheet(mounted).props.onClose())
    expect(sheet(mounted).props.visible).toBe(false)
  })

  it('offers the card menu on a returned card, so a refused message can be fixed rather than retyped', async () => {
    const onEdit = vi.fn(async () => true)
    const mounted = await mount({
      cards: [card({ messageId: 'returned-1', state: 'returned', needsAttention: true })],
      onEdit
    })
    await act(async () =>
      mounted.root.findByProps({ accessibilityLabel: 'More actions' }).props.onPress()
    )
    const actions: ActionSheetAction[] = sheet(mounted).props.actions
    await act(async () => actions[0]!.onPress())
    expect(onEdit).toHaveBeenCalledWith('returned-1')
  })

  it("closes a card's menu for good once the card leaves, even if it comes back", async () => {
    const mounted = await mount({ cards: [card({ messageId: 'a' }), card({ messageId: 'b' })] })
    await act(async () =>
      mounted.root.findAllByProps({ accessibilityLabel: 'More actions' })[0]!.props.onPress()
    )
    expect(sheet(mounted).props.visible).toBe(true)
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, { cards: [card({ messageId: 'b' })] })
      )
    })
    expect(sheet(mounted).props.visible).toBe(false)
    // A Stop requeues a draft under its own id.
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, {
          cards: [card({ messageId: 'a' }), card({ messageId: 'b' })]
        })
      )
    })
    expect(sheet(mounted).props.visible).toBe(false)
  })

  it('runs one action per card at a time, however fast its controls are tapped', async () => {
    let answer: (done: boolean) => void = () => undefined
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    const onDelete = vi.fn(async () => true)
    const mounted = await mount({ cards: [card({ messageId: 'w' })], onSend, onDelete })
    const button = (label: string) =>
      mounted.root.find(
        (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label
      )
    // All three taps land in one frame, before the disabled state can render.
    await act(async () => {
      button('Submit without interrupting the model').props.onPress()
      button('Submit without interrupting the model').props.onPress()
      button('Delete this queued message').props.onPress()
    })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onDelete).not.toHaveBeenCalled()
    expect(button('More actions').props.disabled).toBe(true)
    await act(async () => answer(true))
    expect(button('Submit without interrupting the model').props.disabled).toBe(false)
  })

  describe('a paused queue', () => {
    const waiting = card({ messageId: 'waiting-1', text: 'next' })

    async function mountPaused(
      props: Partial<Parameters<typeof MobileNativeChatQueuedMessages>[0]>
    ): Promise<ReactTestRenderer> {
      return mount({ cards: [waiting], onSend: vi.fn(async () => true), ...props })
    }

    it('heads the box with why the queue is paused, for each reason', async () => {
      const rows: readonly [AgentSessionQueuePause['reason'], string][] = [
        ['stopped', 'Queue paused because you interrupted'],
        ['restarted', 'Queue paused because Orca restarted'],
        ['cleared', 'Queue paused after you cleared the conversation']
      ]
      for (const [reason, label] of rows) {
        const mounted = await mountPaused({ pause: { reason } })
        expect(texts(mounted)).toContain(label)
      }
    })

    it("puts the pause row first in the cards' box, divided from the first card", async () => {
      const mounted = await mountPaused({ pause: { reason: 'stopped' } })
      const pauseRow = mounted.root.findByProps({ testID: 'queued-pause-row' })
      const rowIds = pauseRow.parent!.children.flatMap((child) =>
        typeof child === 'string' ? [] : [child.props.testID]
      )
      expect(rowIds).toEqual(['queued-pause-row', 'queued-card-row'])
      expect(nodeTypes(pauseRow)).toEqual(expect.arrayContaining(['Pause', 'Play']))
      const [cardRow] = mounted.root.findAllByProps({ testID: 'queued-card-row' })
      expect(flatStyle(cardRow!.props.style).borderTopWidth).toBe(1)
    })

    it('shows no pause row without a pause or without cards', async () => {
      expect(texts(await mountPaused({ pause: null }))).not.toContain(
        'Queue paused because you interrupted'
      )
      const empty = await mountPaused({ cards: [], pause: { reason: 'stopped' } })
      expect(empty.toJSON()).toBeNull()
    })

    function resumeButton(mounted: ReactTestRenderer) {
      return mounted.root.findByProps({ accessibilityLabel: 'Resume sending the queued messages' })
    }

    it('Resume asks the host to lift the pause once, however fast it is tapped twice', async () => {
      let answer: (resumed: boolean) => void = () => undefined
      const onResume = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
      const mounted = await mountPaused({ pause: { reason: 'restarted' }, onResume })
      // Both taps land in one frame, before the disabled state can render.
      await act(async () => {
        resumeButton(mounted).props.onPress()
        resumeButton(mounted).props.onPress()
      })
      expect(onResume).toHaveBeenCalledTimes(1)
      await act(async () => answer(true))
    })

    it('re-enables Resume when its answer is lost, so it can be tried again', async () => {
      let answer: (resumed: boolean) => void = () => undefined
      const onResume = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
      const mounted = await mountPaused({ pause: { reason: 'stopped' }, onResume })
      await act(async () => resumeButton(mounted).props.onPress())
      expect(resumeButton(mounted).props.disabled).toBe(true)
      // A lost answer reads as not resumed.
      await act(async () => answer(false))
      expect(resumeButton(mounted).props.disabled).toBe(false)
      await act(async () => resumeButton(mounted).props.onPress())
      expect(onResume).toHaveBeenCalledTimes(2)
    })

    it('keeps every target inside its row, and announces the pause row', async () => {
      const mounted = await mountPaused({ pause: { reason: 'stopped' } })
      const row = mounted.root.findByProps({ testID: 'queued-pause-row' })
      expect(row.props.accessibilityLiveRegion).toBe('polite')
      // Android drops touches outside the parent: nothing may pull a row or a button past its edge.
      const styled = mounted.root.findAll(
        (node) => typeof node.type === 'string' && node.props.style !== undefined
      )
      expect(styled.length).toBeGreaterThan(0)
      for (const node of styled) {
        const style = flatStyle(
          typeof node.props.style === 'function'
            ? node.props.style({ pressed: false })
            : node.props.style
        )
        const margins = Object.entries(style).filter(([key]) => key.startsWith('margin'))
        expect(margins.filter(([, value]) => typeof value === 'number' && value < 0)).toEqual([])
      }
    })

    it('keeps Steer on its cards: one card can still go beside the paused rest', async () => {
      const onSend = vi.fn(async () => true)
      const mounted = await mountPaused({ pause: { reason: 'stopped' }, onSend })
      const steer = mounted.root.findByProps({
        accessibilityLabel: 'Submit without interrupting the model'
      })
      expect(texts(mounted)).toContain('Steer')
      expect(texts(mounted)).not.toContain('Send')
      await act(async () => steer.props.onPress())
      expect(onSend).toHaveBeenCalledWith('waiting-1')
    })
  })

  it('gives every action, Resume included, at least a 44pt touch target in a 44pt row', async () => {
    const mounted = await mount({
      cards: [card({ messageId: 'waiting-1' })],
      pause: { reason: 'stopped' },
      onSend: vi.fn(async () => true),
      onDelete: vi.fn(async () => true),
      onEdit: vi.fn(async () => true)
    })
    const buttons = mounted.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button'
    )
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      'Resume sending the queued messages',
      'Submit without interrupting the model',
      'Delete this queued message',
      'More actions'
    ])
    for (const button of buttons) {
      const style = flatStyle(button.props.style({ pressed: false }))
      expect(style.minHeight).toBeGreaterThanOrEqual(44)
      expect(style.minWidth).toBeGreaterThanOrEqual(44)
    }
    for (const row of [
      mounted.root.findByProps({ testID: 'queued-pause-row' }),
      ...mounted.root.findAllByProps({ testID: 'queued-card-row' })
    ]) {
      expect(flatStyle(row.props.style).minHeight).toBeGreaterThanOrEqual(44)
    }
  })
})
