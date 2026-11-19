import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGuestOverlayScript } from './grab-guest-script'

const aborts: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(aborts.splice(0).map((abort) => abort()))
})

type Picker = {
  awaitEditable: (lastSeen: boolean | null) => Promise<boolean | null>
  cleanup: () => void
}

/** A page with a text field, a button and a field inside an open shadow root, armed with the real picker. */
async function armPage(focusFirst?: 'field') {
  const { Window } = await import('happy-dom')
  const window = new Window()
  aborts.push(() => window.happyDOM.abort())
  const document = window.document
  for (const method of ['showPopover', 'hidePopover']) {
    Object.defineProperty(window.HTMLElement.prototype, method, {
      value: () => {},
      configurable: true
    })
  }
  const field = document.createElement('input')
  const button = document.createElement('button')
  const host = document.createElement('div')
  const shadowField = document.createElement('textarea')
  host.attachShadow({ mode: 'open' }).appendChild(shadowField)
  document.body.append(field, button, host)
  let blurred = false
  field.addEventListener('blur', () => {
    blurred = true
  })
  if (focusFirst === 'field') {
    field.focus()
  }
  const context = {
    window,
    document,
    setTimeout: window.setTimeout.bind(window),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      observe(): void {}
      disconnect(): void {}
    }
  }
  expect(runInNewContext(buildGuestOverlayScript('arm'), context)).toBe(true)
  const picker: Picker = Object.getOwnPropertyDescriptor(window, '__orcaGrab')?.value
  const settle = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 5))
  return { window, field, button, shadowField, picker, settle, wasBlurred: () => blurred }
}

describe('page fields during a pick', () => {
  it('leaves a focused field focused when the picker arms, and reports it as taking typing', async () => {
    const page = await armPage('field')

    expect(page.wasBlurred()).toBe(false)
    expect(page.window.document.activeElement).toBe(page.field)
    await expect(page.picker.awaitEditable(null)).resolves.toBe(true)
  })

  it('follows focus for the whole pick: Tab or page script into a field, a shadow-root field, then a button', async () => {
    const page = await armPage()
    await expect(page.picker.awaitEditable(null)).resolves.toBe(false)

    const intoField = page.picker.awaitEditable(false)
    page.field.focus()
    await expect(intoField).resolves.toBe(true)

    const toButton = page.picker.awaitEditable(true)
    page.button.focus()
    await page.settle()
    await expect(toButton).resolves.toBe(false)

    const intoShadowField = page.picker.awaitEditable(false)
    page.shadowField.focus()
    await expect(intoShadowField).resolves.toBe(true)
  })

  it('releases anyone waiting when the picker is torn down', async () => {
    const page = await armPage()
    const waiting = page.picker.awaitEditable(false)

    page.picker.cleanup()

    await expect(waiting).resolves.toBeNull()
  })
})
