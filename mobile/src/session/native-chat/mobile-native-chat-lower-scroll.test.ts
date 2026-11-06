// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectMobileNativeChatLowerScroll } from './mobile-native-chat-lower-scroll'

let root: HTMLDivElement
let viewport: HTMLDivElement
let content: HTMLDivElement
let anchor: HTMLParagraphElement
let field: HTMLTextAreaElement
let group: HTMLDivElement
let viewportHeight: number
let extent: number
let addedAbove: number
let addedBeforeField: number
let connection: ReturnType<typeof connectMobileNativeChatLowerScroll> | undefined

const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

beforeEach(() => {
  viewportHeight = 100
  extent = 350
  addedAbove = 0
  addedBeforeField = 0
  root = document.createElement('div')
  root.dataset.testid = 'native-chat-view'
  viewport = document.createElement('div')
  content = document.createElement('div')
  anchor = document.createElement('p')
  group = document.createElement('div')
  group.dataset.testid = 'native-chat-composer-group'
  field = document.createElement('textarea')
  field.value = 'A separate retained draft'
  group.append(field)
  content.append(anchor, group)
  viewport.append(content)
  root.append(viewport)
  document.body.append(root)
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, 600))
  vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 300, viewportHeight)
  )
  Object.defineProperties(viewport, {
    clientHeight: { get: () => viewportHeight },
    clientWidth: { value: 300 },
    scrollHeight: { get: () => extent + addedAbove + addedBeforeField }
  })
  vi.spyOn(content, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, -viewport.scrollTop, 300, extent + addedAbove + addedBeforeField)
  )
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, addedAbove - viewport.scrollTop, 300, 200)
  )
  vi.spyOn(group, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 220 + addedAbove + addedBeforeField - viewport.scrollTop, 300, 130)
  )
  vi.spyOn(field, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 260 + addedAbove + addedBeforeField - viewport.scrollTop, 300, 30)
  )
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => {
    const rect = anchor.getBoundingClientRect()
    return rect.top <= 4 && rect.bottom > 4 ? anchor : null
  })
})

afterEach(() => {
  connection?.dispose()
  connection = undefined
  root.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function connect() {
  connection = connectMobileNativeChatLowerScroll(viewport, content, () => {})
  return connection
}

function userScroll(offset: number) {
  viewport.dispatchEvent(new WheelEvent('wheel'))
  viewport.scrollTop = offset
  viewport.dispatchEvent(new Event('scroll'))
  viewport.dispatchEvent(new Event('scrollend'))
}

it('starts at the bottom and keeps newly inserted lower content reachable while attached', async () => {
  const lower = connect()
  await painted()
  expect(viewport.scrollTop).toBe(250)
  addedAbove = 80
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(330)
})

it('reveals the focused editor after an inline menu appears without another focus event', async () => {
  const lower = connect()
  field.focus()
  await painted()
  expect(viewport.scrollTop).toBe(190)
  addedBeforeField = 20
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(210)
  addedAbove = 80
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(290)
  expect(document.activeElement).toBe(field)
  expect(field.value).toBe('A separate retained draft')
})

it('holds the visible content after deliberate scrolling and drops a removed anchor', async () => {
  const lower = connect()
  field.focus()
  await painted()
  userScroll(140)
  await painted()
  addedAbove = 80
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(220)
  expect(anchor.getBoundingClientRect().top).toBe(-140)
  anchor.remove()
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(220)
  expect(document.activeElement).toBe(field)
  addedAbove = 120
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(220)
})

it('lets deliberate scrolling cancel a pending field reveal across an unrelated layout', async () => {
  const lower = connect()
  field.focus()
  await painted()
  lower.reveal(group)
  userScroll(130)
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(130)
  expect(document.activeElement).toBe(field)
})

it('defers anchor correction through canceled touch pointers until every contact ends', async () => {
  const lower = connect()
  await painted()
  const touched = document.createElement('div')
  content.append(touched)
  const touch = (type: string, count: number) => {
    const event = new TouchEvent(type, {
      bubbles: true,
      touches: Array.from(
        { length: count },
        (_, identifier) => new Touch({ identifier, target: touched })
      )
    })
    touched.dispatchEvent(event)
  }
  vi.useFakeTimers()
  touch('touchstart', 2)
  viewport.scrollTop = 140
  viewport.dispatchEvent(new Event('scroll'))
  const canceled = new Event('pointercancel', { bubbles: true })
  Object.defineProperty(canceled, 'pointerType', { value: 'touch' })
  viewport.dispatchEvent(canceled)
  addedAbove = 80
  lower.layoutChanged()
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(140)
  viewport.scrollTop = 130
  lower.layoutChanged()
  await vi.advanceTimersByTimeAsync(20)
  viewport.dispatchEvent(new Event('scroll'))
  touch('touchend', 1)
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(130)
  touched.remove()
  touch('touchend', 0)
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(210)
  lower.layoutChanged()
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(210)
})

it('carries a correction into a new visible anchor before a later insertion', async () => {
  extent = 550
  const next = document.createElement('p')
  content.append(next)
  vi.spyOn(next, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 200 + addedAbove + addedBeforeField - viewport.scrollTop, 300, 180)
  )
  const lower = connect()
  await painted()
  userScroll(140)
  await painted()
  vi.useFakeTimers()
  viewport.dispatchEvent(
    new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 1, bubbles: true })
  )
  addedAbove = 80
  lower.layoutChanged()
  await vi.advanceTimersByTimeAsync(20)
  vi.mocked(document.elementFromPoint).mockReturnValue(next)
  viewport.scrollTop = 280
  viewport.dispatchEvent(new Event('scroll'))
  anchor.remove()
  addedBeforeField = 40
  lower.layoutChanged()
  document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 1 }))
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(400)
  expect(next.getBoundingClientRect().top).toBe(-80)
  lower.layoutChanged()
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(400)
})

it('preserves outer layout displacement without undoing a nested scroll', async () => {
  const inner = document.createElement('div')
  content.prepend(inner)
  inner.append(anchor)
  vi.mocked(anchor.getBoundingClientRect).mockImplementation(
    () => new DOMRect(0, addedAbove - viewport.scrollTop - inner.scrollTop, 300, 200)
  )
  const lower = connect()
  await painted()
  userScroll(140)
  await painted()
  vi.useFakeTimers()
  viewport.dispatchEvent(
    new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 2, bubbles: true })
  )
  addedAbove = 80
  lower.layoutChanged()
  inner.scrollTop = 30
  inner.dispatchEvent(new Event('scroll'))
  document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 2 }))
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(220)
  expect(inner.scrollTop).toBe(30)
  expect(anchor.getBoundingClientRect().top).toBe(-170)
})

it('retires an unreachable correction after native range clamping without attaching', async () => {
  extent = 550
  group.remove()
  vi.mocked(anchor.getBoundingClientRect).mockImplementation(
    () => new DOMRect(0, 140 + addedAbove - viewport.scrollTop, 300, 20)
  )
  const lower = connect()
  await painted()
  userScroll(140)
  await painted()
  addedAbove = 40
  extent = 160
  viewport.scrollTop = 100
  viewport.dispatchEvent(new Event('scroll'))
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(100)
  extent = 550
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(100)
  addedAbove = 80
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(140)
})

it('preserves user navigation through a rubber-band excursion without writing against the bounce', async () => {
  const lower = connect()
  await painted()
  userScroll(0)
  await painted()
  viewport.dispatchEvent(new WheelEvent('wheel'))
  viewport.scrollTop = -20
  viewport.dispatchEvent(new Event('scroll'))
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(-20)
  viewport.scrollTop = 15
  viewport.dispatchEvent(new Event('scroll'))
  viewport.dispatchEvent(new Event('scrollend'))
  await painted()
  expect(viewport.scrollTop).toBe(15)
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(15)
  userScroll(250)
  await painted()
  viewport.dispatchEvent(new WheelEvent('wheel'))
  viewport.scrollTop = 270
  viewport.dispatchEvent(new Event('scroll'))
  viewport.scrollTop = 230
  viewport.dispatchEvent(new Event('scroll'))
  viewport.dispatchEvent(new Event('scrollend'))
  await painted()
  expect(viewport.scrollTop).toBe(230)
})

it('reveals a fitting composer surface through menu entry and removal despite incidental movement', async () => {
  viewportHeight = 219
  extent = 900
  const inset = document.createElement('div')
  inset.dataset.testid = 'native-chat-composer-inset'
  group.append(inset)
  inset.append(field)
  vi.mocked(group.getBoundingClientRect).mockImplementation(
    () => new DOMRect(0, -viewport.scrollTop, 300, 900)
  )
  vi.spyOn(inset, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 634 + addedBeforeField - viewport.scrollTop, 300, 214)
  )
  vi.mocked(field.getBoundingClientRect).mockImplementation(
    () => new DOMRect(0, 653 + addedBeforeField - viewport.scrollTop, 300, 128)
  )
  const lower = connect()
  field.focus()
  await painted()
  userScroll(637)
  await painted()
  expect(inset.getBoundingClientRect().top).toBe(-3)
  addedBeforeField = 301
  lower.reveal(group, 'menu')
  viewport.scrollTop = 938
  viewport.dispatchEvent(new Event('scroll'))
  lower.layoutChanged()
  await painted()
  expect(inset.getBoundingClientRect().top).toBe(5)
  expect(inset.getBoundingClientRect().bottom).toBe(219)
  addedBeforeField = 0
  lower.reveal(group, 'edit')
  viewport.scrollTop = 594
  field.scrollTop = 30
  field.dispatchEvent(new Event('scroll', { bubbles: true }))
  viewport.dispatchEvent(new Event('scroll'))
  await painted()
  expect(inset.getBoundingClientRect().top).toBe(5)
  expect(inset.getBoundingClientRect().bottom).toBe(219)
  expect(field.scrollTop).toBe(30)
  expect(document.activeElement).toBe(field)
  expect(field.value).toBe('A separate retained draft')
})

it('keeps a deliberately offscreen field offscreen when its fitting frame still intersects', async () => {
  viewportHeight = 219
  extent = 900
  const inset = document.createElement('div')
  inset.dataset.testid = 'native-chat-composer-inset'
  group.append(inset)
  inset.append(field)
  vi.mocked(group.getBoundingClientRect).mockImplementation(
    () => new DOMRect(0, -viewport.scrollTop, 300, 900)
  )
  vi.spyOn(inset, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 634 + addedBeforeField - viewport.scrollTop, 300, 214)
  )
  vi.mocked(field.getBoundingClientRect).mockImplementation(
    () => new DOMRect(0, 653 + addedBeforeField - viewport.scrollTop, 300, 128)
  )
  const lower = connect()
  field.focus()
  await painted()
  userScroll(429)
  await painted()
  expect(inset.getBoundingClientRect().top).toBe(205)
  expect(field.getBoundingClientRect().top).toBe(224)
  addedBeforeField = 40
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(429)
  expect(document.activeElement).toBe(field)
  expect(field.value).toBe('A separate retained draft')
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await painted()
  expect(inset.getBoundingClientRect().top).toBe(5)
  expect(inset.getBoundingClientRect().bottom).toBe(219)
})

it('keeps new Tab and tap focus reveals while later navigation cancels and editing keys do not', async () => {
  const lower = connect()
  vi.useFakeTimers()
  field.focus()
  await vi.advanceTimersByTimeAsync(20)
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  field.blur()
  field.focus()
  viewport.scrollTop = 0
  viewport.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(190)
  field.blur()
  field.dispatchEvent(
    new PointerEvent('pointerdown', { pointerType: 'mouse', pointerId: 3, bubbles: true })
  )
  field.focus()
  viewport.scrollTop = 0
  viewport.dispatchEvent(new Event('scroll'))
  field.dispatchEvent(
    new PointerEvent('pointermove', { pointerType: 'mouse', pointerId: 3, bubbles: true })
  )
  document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', pointerId: 3 }))
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(190)
  lower.reveal(group, 'edit')
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  viewport.scrollTop = 0
  viewport.dispatchEvent(new Event('scroll'))
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(190)
  lower.reveal(group)
  group.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
  viewport.scrollTop = 130
  viewport.dispatchEvent(new Event('scroll'))
  viewport.dispatchEvent(new Event('scrollend'))
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(130)
})
