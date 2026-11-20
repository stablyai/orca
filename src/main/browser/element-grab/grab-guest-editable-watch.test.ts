import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEditableAwaitScript, buildEditableStopScript } from './grab-guest-editable-watch'

const aborts: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(aborts.splice(0).map((abort) => abort()))
})

/** A page with a text field, a button, a field in an open shadow root and a custom element with a closed one. */
async function page() {
  const { Window } = await import('happy-dom')
  const window = new Window()
  aborts.push(() => window.happyDOM.abort())
  const document = window.document
  const field = document.createElement('input')
  const button = document.createElement('button')
  const openHost = document.createElement('div')
  const openField = document.createElement('textarea')
  openHost.attachShadow({ mode: 'open' }).appendChild(openField)
  const closedHost = document.createElement('rich-editor')
  closedHost.tabIndex = 0
  closedHost.attachShadow({ mode: 'closed' }).appendChild(document.createElement('textarea'))
  document.body.append(field, button, openHost, closedHost)
  // The isolated world: same DOM, its own globals.
  const world = { window, document, setTimeout: window.setTimeout.bind(window), globalThis: {} }
  world.globalThis = world
  const awaitState = (token: number, lastSeen: boolean | null): Promise<boolean | null> =>
    runInNewContext(buildEditableAwaitScript(token, lastSeen), world)
  const settle = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 5))
  return { field, button, openField, closedHost, awaitState, world, settle }
}

describe('the isolated field-focus tracker', () => {
  it('follows focus into a field, a field in an open shadow root, and off them', async () => {
    const p = await page()
    await expect(p.awaitState(1, null)).resolves.toBe(false)

    const intoField = p.awaitState(1, false)
    p.field.focus()
    await expect(intoField).resolves.toBe(true)

    const toButton = p.awaitState(1, true)
    p.button.focus()
    await p.settle()
    await expect(toButton).resolves.toBe(false)

    const intoShadow = p.awaitState(1, false)
    p.openField.focus()
    await expect(intoShadow).resolves.toBe(true)
  })

  it('treats a focused custom element it cannot see into (closed shadow root) as a field', async () => {
    const p = await page()
    await expect(p.awaitState(1, null)).resolves.toBe(false)

    const intoClosed = p.awaitState(1, false)
    p.closedHost.focus()

    await expect(intoClosed).resolves.toBe(true)
  })

  it('releases a waiting reply when its watch is stopped or replaced', async () => {
    const p = await page()
    await p.awaitState(1, null)
    const stopped = p.awaitState(1, false)
    runInNewContext(buildEditableStopScript(1), p.world)
    await expect(stopped).resolves.toBeNull()

    await p.awaitState(2, null)
    const replaced = p.awaitState(2, false)
    await p.awaitState(3, null)
    await expect(replaced).resolves.toBeNull()
  })
})
