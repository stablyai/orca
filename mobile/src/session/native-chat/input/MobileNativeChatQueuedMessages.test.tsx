import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../../../components/ActionSheetModal'
import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'
import type { MobileQueuedMessageCard } from '../../mobile-structured-queued-message-cards'

let fontScale = 1
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale }),
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  AlertCircle: 'AlertCircle',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  CornerDownRight: 'CornerDownRight',
  ListEnd: 'ListEnd',
  MoreHorizontal: 'MoreHorizontal',
  Pencil: 'Pencil',
  Play: 'Play',
  Send: 'Send',
  Trash2: 'Trash2',
  X: 'X'
}))

vi.mock('../../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))

function card(
  overrides: Partial<MobileQueuedMessageCard> & { messageId: string }
): MobileQueuedMessageCard {
  return {
    text: `text of ${overrides.messageId}`,
    state: 'waiting',
    paused: false,
    needsAttention: false,
    caption: null,
    attribution: null,
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
      .findAll((node) => String(node.type) === 'Text' && !node.props.accessibilityElementsHidden)
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

  it('edits in place of the card row with an X and a checkmark while keeping another card visible', async () => {
    const change = vi.fn()
    const save = vi.fn(async () => true)
    const cancel = vi.fn()
    const mounted = await mount({
      cards: [
        card({
          messageId: 'a',
          attribution: 'From Alex',
          caption: 'Returned',
          needsAttention: true,
          state: 'returned'
        }),
        card({ messageId: 'b' })
      ],
      editor: {
        messageId: 'a',
        text: 'edited text',
        saving: false,
        canSave: true,
        change,
        save,
        cancel
      }
    })
    const input = mounted.root.findByProps({ accessibilityLabel: 'Edit queued message' })
    expect(input.props.value).toBe('edited text')
    const editedRow = mounted.root.findAllByProps({ testID: 'queued-card-row' })[0]!
    expect(texts(mounted)).toContain('From Alex')
    expect(texts(mounted)).not.toContain('Editing message')
    expect(texts(mounted)).not.toContain('Returned')
    expect(nodeTypes(editedRow)).toEqual(expect.arrayContaining(['X', 'Check']))
    expect(nodeTypes(editedRow)).not.toContain('Pencil')
    expect(nodeTypes(editedRow)).not.toContain('AlertCircle')
    expect(
      editedRow.findAll((node) => node.props.accessibilityLabel === 'Delete this queued message')
    ).toHaveLength(0)
    act(() => input.props.onChangeText('updated text'))
    expect(change).toHaveBeenCalledWith('updated text')
    const button = (label: string) => mounted.root.findByProps({ accessibilityLabel: label })
    await act(async () => button('Save edited message').props.onPress())
    expect(save).toHaveBeenCalledOnce()
    act(() => button('Cancel editing').props.onPress())
    expect(cancel).toHaveBeenCalledOnce()
    expect(mounted.root.findAllByProps({ testID: 'queued-card-row' })).toHaveLength(2)
    expect(mounted.root.findByProps({ accessibilityLabel: 'More actions' }).props.disabled).toBe(
      true
    )
    const editAgain = (state: { saving: boolean; canSave: boolean }) =>
      act(async () =>
        mounted.update(
          createElement(MobileNativeChatQueuedMessages, {
            cards: [card({ messageId: 'a' })],
            editor: { messageId: 'a', text: '', change, save, cancel, ...state }
          })
        )
      )
    await editAgain({ saving: false, canSave: false })
    expect(button('Save edited message').props.disabled).toBe(true)
    expect(button('Cancel editing').props.disabled).toBe(false)
    await editAgain({ saving: true, canSave: true })
    const saveButton = button('Save edited message')
    expect(saveButton.props.disabled).toBe(true)
    expect(saveButton.props.accessibilityState).toEqual({ disabled: true })
    expect(saveButton.props['aria-busy']).toBe(true)
    expect(nodeTypes(saveButton)).toContain('ActivityIndicator')
    expect(nodeTypes(saveButton)).not.toContain('Check')
    expect(button('Cancel editing').props.disabled).toBe(true)
    expect(button('Edit queued message').props.editable).toBe(false)
  })

  it('draws a plain waiting card as one compact row with no caption', async () => {
    const mounted = await mount({ cards: [card({ messageId: 'w', text: 'next' })] })
    const rows = mounted.root.findAllByProps({ testID: 'queued-card-row' })
    expect(rows).toHaveLength(1)
    expect(texts(mounted)).toEqual(['Queued', 1, 'next', 'Steer'])
    expect(
      mounted.root.find(
        (node) =>
          String(node.type) === 'Text' &&
          node.props.children === 'next' &&
          !node.props.accessibilityElementsHidden
      ).props.numberOfLines
    ).toBe(2)
    expect(nodeTypes(rows[0]!)).toContain('ListEnd')
    expect(nodeTypes(rows[0]!)).not.toContain('AlertCircle')
  })

  async function layOut(mounted: ReactTestRenderer, text: string, lines: number): Promise<void> {
    const measure = mounted.root.find(
      (node) =>
        String(node.type) === 'Text' &&
        node.props.children === text &&
        typeof node.props.onTextLayout === 'function'
    )
    await act(async () =>
      measure.props.onTextLayout({ nativeEvent: { lines: Array.from({ length: lines }) } })
    )
  }

  it('a clipped card opens to the whole message on tap, line breaks kept, and a second tap folds it', async () => {
    const text = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`).join('\n')
    const mounted = await mount({
      cards: [card({ messageId: 'mail', text })],
      onSend: vi.fn(async () => true),
      onDelete: vi.fn(async () => true),
      onEdit: vi.fn(async () => true)
    })
    await layOut(mounted, text, 5)
    const body = () =>
      mounted.root.find(
        (node) =>
          String(node.type) === 'Text' &&
          node.props.children === text &&
          node.props.onTextLayout === undefined
      )
    const toggle = () => mounted.root.findByProps({ testID: 'queued-card-text' })
    expect(body().props.numberOfLines).toBe(2)
    expect(toggle().props.accessibilityState).toEqual({ expanded: false })
    expect(texts(mounted)).toContain('Show more')
    await act(async () => toggle().props.onPress())
    expect(body().props.numberOfLines).toBeUndefined()
    expect(toggle().props.accessibilityState).toEqual({ expanded: true })
    expect(texts(mounted)).toContain('Show less')
    const row = mounted.root.findByProps({ testID: 'queued-card-row' })
    const controlLine = row.findByProps({ accessibilityLabel: 'More actions' }).parent?.parent
    expect(controlLine?.findAll((node) => node === body())).toHaveLength(0)
    expect(body().parent?.parent?.parent).toBe(row)
    expect(row.children.indexOf(controlLine!)).toBeLessThan(
      row.children.indexOf(body().parent!.parent!)
    )
    const scrolls = mounted.root.findAll((node) => String(node.type) === 'ScrollView')
    expect(scrolls).toHaveLength(1)
    expect(flatStyle(scrolls[0]!.props.style).maxHeight).toBe(160)
    await act(async () => body().parent?.props.onPress())
    expect(body().props.numberOfLines).toBe(2)
    await act(async () => toggle().props.onPress())
    await act(async () => toggle().props.onPress())
    expect(body().props.numberOfLines).toBe(2)
  })

  it('a card whose text fits its two lines is plain text, not a button', async () => {
    const mounted = await mount({ cards: [card({ messageId: 'short', text: 'ok' })] })
    await layOut(mounted, 'ok', 1)
    expect(mounted.root.findAllByProps({ testID: 'queued-card-text' })).toHaveLength(0)
    expect(texts(mounted)).not.toContain('Show more')
  })

  it('divides rows with hairlines inside one box, the header undivided', async () => {
    const mounted = await mount({ cards: [card({ messageId: 'a' }), card({ messageId: 'b' })] })
    const rows = [
      mounted.root.findByProps({ testID: 'queued-header' }),
      ...mounted.root.findAllByProps({ testID: 'queued-card-row' })
    ]
    expect(rows.map((row) => Boolean(flatStyle(row.props.style).borderTopWidth))).toEqual([
      false,
      true,
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
    const reason = Array.from({ length: 100 }, (_, index) => `Rejection line ${index + 1}`).join(
      '\n'
    )
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
    expect(caption.parent?.parent).toBe(returnedRow)
    expect(returnedRow!.children.indexOf(caption.parent!)).toBe(1)
    expect(nodeTypes(waitingRow!)).not.toContain('AlertCircle')
    const toggle = () => mounted.root.findByProps({ accessibilityLabel: 'Queued messages' })
    await act(async () => toggle().props.onPress())
    expect(mounted.root.findAllByProps({ testID: 'queued-card-row' })).toHaveLength(0)
    expect(texts(mounted)).toContain(`· ${reason}`)
    const headerCaption = mounted.root
      .findByProps({ testID: 'queued-header' })
      .find((node) => String(node.type) === 'Text' && node.props.children === `· ${reason}`)
    expect(flatStyle(headerCaption.props.style).color).toBe('#ef4444')
    await act(async () => toggle().props.onPress())
    expect(texts(mounted).filter((text) => text === reason)).toHaveLength(1)
  })

  it('reads Steer on a waiting card and plain Send on a returned one or one whose own send failed', async () => {
    const mounted = await mount({
      cards: [
        card({
          messageId: 'failed',
          paused: true,
          needsAttention: true,
          caption: "Couldn't send — tap Send to retry"
        }),
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
    const toggle = () => mounted.root.findByProps({ accessibilityLabel: 'Queued messages' })
    await act(async () => toggle().props.onPress())
    expect(texts(mounted)).toContain("· Couldn't send — tap Send to retry")
    await act(async () => toggle().props.onPress())
    expect(
      texts(mounted).filter((text) => text === "Couldn't send — tap Send to retry")
    ).toHaveLength(1)
  })

  it('a command card never steers: Send only while the agent is idle, and no menu', async () => {
    const onSend = vi.fn(async () => true)
    const mounted = await mount({
      cards: [
        card({ messageId: 'working', text: '/compact', command: true, waitsForAgent: true }),
        card({ messageId: 'idle', text: '/compact', command: true })
      ],
      onSend
    })
    expect(texts(mounted).filter((text) => text === 'Send' || text === 'Steer')).toEqual(['Send'])
    await act(async () => {
      mounted.root.findByProps({ accessibilityLabel: 'Send this message' }).props.onPress()
    })
    expect(onSend).toHaveBeenCalledWith('idle')
    expect(mounted.root.findAllByProps({ accessibilityLabel: 'More actions' })).toHaveLength(0)
    expect(
      mounted.root.findAllByProps({ accessibilityLabel: 'Delete this queued message' })
    ).toHaveLength(2)
  })

  it("a paused command card's ways out are Delete and the queue's Resume", async () => {
    const onResume = vi.fn(async () => true)
    const onDelete = vi.fn(async () => true)
    const mounted = await mount({
      cards: [card({ messageId: 'compact', text: '/compact', command: true })],
      pause: { reason: 'stopped' },
      onResume,
      onDelete
    })
    await act(async () => {
      mounted.root
        .findByProps({ accessibilityLabel: 'Resume sending the queued messages' })
        .props.onPress()
    })
    expect(onResume).toHaveBeenCalledOnce()
    await act(async () => {
      mounted.root.findByProps({ accessibilityLabel: 'Delete this queued message' }).props.onPress()
    })
    expect(onDelete).toHaveBeenCalledWith('compact')
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
    // Tap all actions before disabled state renders to expose same-frame duplication.
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
      return mount({
        cards: [waiting],
        onSend: vi.fn(async () => true),
        onClearAll: vi.fn(async () => true),
        ...props
      })
    }

    it('heads the box with Paused, the count, Clear all and Resume; unpaused, Queued and the count', async () => {
      const header = (mounted: ReactTestRenderer) =>
        mounted.root.findByProps({ testID: 'queued-header' })
      const paused = await mountPaused({ pause: { reason: 'stopped' } })
      expect(texts(paused).slice(0, 4)).toEqual(['Paused', 1, 'Clear all', 'Resume'])
      expect(nodeTypes(header(paused))).toEqual(expect.arrayContaining(['Trash2', 'Play']))
      const scroll = header(paused).parent!.find((node) => String(node.type) === 'ScrollView')
      const rowIds = [header(paused), ...scroll.findAllByProps({ testID: 'queued-card-row' })].map(
        (row) => row.props.testID
      )
      expect(rowIds).toEqual(['queued-header', 'queued-card-row'])
      const [cardRow] = paused.root.findAllByProps({ testID: 'queued-card-row' })
      expect(flatStyle(cardRow!.props.style).borderTopWidth).toBe(1)
      const unpaused = await mountPaused({ pause: null })
      expect(texts(unpaused).slice(0, 2)).toEqual(['Queued', 1])
      expect(texts(unpaused)).not.toContain('Resume')
      const empty = await mountPaused({ cards: [], pause: { reason: 'stopped' } })
      expect(empty.toJSON()).toBeNull()
    })

    it('Clear all captures card ids while Resume and Steer stay available', async () => {
      const release = Promise.withResolvers<boolean>()
      const onClearAll = vi.fn(() => release.promise)
      const onResume = vi.fn(async () => true)
      const onSend = vi.fn(async () => true)
      const mounted = await mountPaused({
        cards: [waiting, card({ messageId: 'b' }), card({ messageId: 'c' })],
        pause: { reason: 'stopped' },
        onClearAll,
        onResume,
        onSend
      })
      await act(async () =>
        mounted.root
          .findByProps({ accessibilityLabel: 'Delete every queued message' })
          .props.onPress()
      )
      expect(onClearAll).toHaveBeenCalledExactlyOnceWith(['waiting-1', 'b', 'c'])
      expect(
        mounted.root.findByProps({ accessibilityLabel: 'Delete every queued message' }).props
          .disabled
      ).toBe(true)
      const resume = mounted.root.findByProps({
        accessibilityLabel: 'Resume sending the queued messages'
      })
      const steer = mounted.root.findAllByProps({
        accessibilityLabel: 'Submit without interrupting the model'
      })[0]
      expect(resume.props.disabled).toBe(false)
      expect(steer.props.disabled).toBe(false)
      await act(async () => {
        resume.props.onPress()
        steer.props.onPress()
      })
      expect(onResume).toHaveBeenCalledOnce()
      expect(onSend).toHaveBeenCalledOnce()
      await act(async () => release.resolve(true))
    })

    it('the chevron folds only the cards; the header and its actions stay', async () => {
      const mounted = await mountPaused({ pause: { reason: 'stopped' } })
      const toggle = () => mounted.root.findByProps({ accessibilityLabel: 'Queued messages' })
      expect(toggle().props.accessibilityState).toEqual({ expanded: true })
      await act(async () => toggle().props.onPress())
      expect(toggle().props.accessibilityState).toEqual({ expanded: false })
      expect(mounted.root.findAllByProps({ testID: 'queued-card-row' })).toHaveLength(0)
      expect(texts(mounted)).toEqual(['Paused', 1, 'Clear all', 'Resume'])
    })

    function resumeButton(mounted: ReactTestRenderer) {
      return mounted.root.findByProps({ accessibilityLabel: 'Resume sending the queued messages' })
    }

    it('Resume asks the host to lift the pause once, however fast it is tapped twice', async () => {
      let answer: (resumed: boolean) => void = () => undefined
      const onResume = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
      const mounted = await mountPaused({ pause: { reason: 'stopped' }, onResume })
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
      await act(async () => answer(false))
      expect(resumeButton(mounted).props.disabled).toBe(false)
      await act(async () => resumeButton(mounted).props.onPress())
      expect(onResume).toHaveBeenCalledTimes(2)
    })

    it('keeps every target inside its row, and announces the header', async () => {
      const mounted = await mountPaused({ pause: { reason: 'stopped' } })
      const row = mounted.root.findByProps({ testID: 'queued-header' })
      expect(row.props.accessibilityLiveRegion).toBe('polite')
      // Android ignores touches outside the parent; keep buttons inside and tuck the box with noninteractive padding.
      const styled = mounted.root
        .findByProps({ testID: 'queued-box' })
        .findAll((node) => typeof node.type === 'string' && node.props.style !== undefined)
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

    it('at large text keeps Clear all and Resume on their own line while a card is edited', async () => {
      fontScale = 2
      try {
        const mounted = await mountPaused({
          pause: { reason: 'stopped' },
          editor: {
            messageId: 'waiting-1',
            text: 'next',
            saving: false,
            canSave: true,
            change: vi.fn(),
            save: vi.fn(async () => true),
            cancel: vi.fn()
          }
        })
        const header = mounted.root.findByProps({ testID: 'queued-header' })
        for (const label of ['Delete every queued message', 'Resume sending the queued messages']) {
          const button = mounted.root.findByProps({ accessibilityLabel: label })
          expect(header.findAll((node) => node === button)).toHaveLength(0)
        }
      } finally {
        fontScale = 1
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

  it('gives every card action a 44pt-tall target in a 44pt row, under a 32pt header', async () => {
    const mounted = await mount({
      cards: [card({ messageId: 'waiting-1' })],
      pause: { reason: 'stopped' },
      onSend: vi.fn(async () => true),
      onDelete: vi.fn(async () => true),
      onClearAll: vi.fn(async () => true),
      onEdit: vi.fn(async () => true)
    })
    const buttons = mounted.root.findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'button' &&
        node.props.testID !== 'queued-card-text'
    )
    const style = (button: (typeof buttons)[number]) =>
      flatStyle(button.props.style({ pressed: false }))
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      'Queued messages',
      'Delete every queued message',
      'Resume sending the queued messages',
      'Submit without interrupting the model',
      'Delete this queued message',
      'More actions'
    ])
    const header = mounted.root.findByProps({ testID: 'queued-header' })
    expect(flatStyle(header.props.style).minHeight).toBe(32)
    expect(style(buttons[0]!)).toMatchObject({ position: 'absolute', top: 0, bottom: 0 })
    for (const button of buttons.slice(1, 3)) {
      expect(style(button).minHeight).toBe(32)
      expect(style(button).height).toBeUndefined()
      expect(style(button).minWidth).toBeGreaterThanOrEqual(44)
    }
    const cardActions = buttons.slice(3).map(style)
    for (const action of cardActions) {
      expect(action.minHeight).toBeGreaterThanOrEqual(44)
    }
    expect(cardActions[0]!.minWidth).toBe(44)
    expect(cardActions.map((action) => action.width)).toEqual([undefined, 40, 44])
    for (const row of mounted.root.findAllByProps({ testID: 'queued-card-row' })) {
      expect(flatStyle(row.props.style).minHeight).toBeGreaterThanOrEqual(44)
    }
  })

  it('caps a long queue in a scrolling list and shows a card the person just queued', async () => {
    const scrollToEnd = vi.fn()
    const mounted = create(createElement('View'), {
      createNodeMock: (element) =>
        element.type === 'ScrollView' ? { scrollToEnd, flashScrollIndicators: vi.fn() } : null
    })
    renderer = mounted
    const ids = ['a', 'b', 'c', 'd', 'e']
    const show = async (cards: MobileQueuedMessageCard[]) => {
      await act(async () => {
        mounted.update(createElement(MobileNativeChatQueuedMessages, { cards }))
      })
      return mounted.root.find((node) => String(node.type) === 'ScrollView')
    }
    const scroll = await show(ids.map((messageId) => card({ messageId })))
    expect(flatStyle(scroll.props.style).maxHeight).toBe(160)
    expect(scroll.findAllByProps({ testID: 'queued-header' })).toHaveLength(0)
    expect(scroll.findAllByProps({ testID: 'queued-card-row' })).toHaveLength(5)
    await act(async () => scroll.props.onContentSizeChange(0, ids.length * 44))
    expect(scrollToEnd).not.toHaveBeenCalled()
    await show([...ids, 'f'].map((messageId) => card({ messageId, attribution: 'From Alex' })))
    expect(scrollToEnd).not.toHaveBeenCalled()
    await show([...ids, 'f', 'g'].map((messageId) => card({ messageId })))
    expect(scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: false })
    scrollToEnd.mockClear()
    await show(['b', 'c', 'd', 'e', 'f', 'g', 'h'].map((messageId) => card({ messageId })))
    expect(scrollToEnd).toHaveBeenCalledExactlyOnceWith({ animated: false })
    scrollToEnd.mockClear()
    await act(async () => scroll.props.onContentSizeChange(0, 2400))
    await show(
      ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((messageId) =>
        card({ messageId, attribution: 'From Alex' })
      )
    )
    await act(async () => scroll.props.onContentSizeChange(0, 2444))
    expect(scrollToEnd).not.toHaveBeenCalled()
  })
})
