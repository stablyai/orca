// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectMobileNativeChatLowerScroll } from './mobile-native-chat-lower-scroll'

let root: HTMLDivElement
let viewport: HTMLDivElement
let content: HTMLDivElement
let anchor: HTMLParagraphElement
let field: HTMLTextAreaElement
let group: HTMLDivElement
let addedAbove: number
let addedBeforeField: number
let connection: ReturnType<typeof connectMobileNativeChatLowerScroll> | undefined

const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

beforeEach(() => {
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
  vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 300, 100))
  Object.defineProperties(viewport, {
    clientHeight: { value: 100 },
    clientWidth: { value: 300 },
    scrollHeight: { get: () => 350 + addedAbove + addedBeforeField }
  })
  vi.spyOn(content, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, -viewport.scrollTop, 300, 350 + addedAbove + addedBeforeField)
  )
  vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 200 + addedAbove - viewport.scrollTop, 300, 20)
  )
  vi.spyOn(group, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 220 + addedAbove + addedBeforeField - viewport.scrollTop, 300, 130)
  )
  vi.spyOn(field, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 260 + addedAbove + addedBeforeField - viewport.scrollTop, 300, 30)
  )
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => anchor)
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
  expect(anchor.getBoundingClientRect().top).toBe(60)
  anchor.remove()
  lower.layoutChanged()
  await painted()
  expect(viewport.scrollTop).toBe(220)
  expect(document.activeElement).toBe(field)
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
  touch('touchend', 1)
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(140)
  touched.remove()
  touch('touchend', 0)
  await vi.advanceTimersByTimeAsync(200)
  expect(viewport.scrollTop).toBe(220)
})
