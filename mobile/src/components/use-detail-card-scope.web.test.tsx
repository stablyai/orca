// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { assert, expect, it, vi } from 'vitest'
import { useDetailCardScope } from './use-detail-card-scope.web'

it('owns keys, reading and focus through exit, then yields to a higher sheet', async () => {
  const root = document.createElement('div')
  root.innerHTML = `<div><input id="terminal"><button id="opener"><span id="title">Title</span><span id="status">Status</span></button></div><div><div id="layer"><div id="card" tabindex="-1"><div id="scroll" tabindex="0">Full details</div></div></div></div>`
  document.body.append(root)
  const higher = document.createElement('button')
  document.body.append(higher)
  const node = (id: string) => {
    const found = root.querySelector(`#${id}`)
    if (!(found instanceof HTMLElement)) {
      throw new Error(id)
    }
    return found
  }
  const dismiss = vi.fn()
  const refs = {
    openerRef: { current: node('opener') },
    titleRef: { current: node('title') },
    layerRef: { current: node('layer') },
    contentRef: { current: node('card') }
  }
  function Scope({ present, obscured = false }: { present: boolean; obscured?: boolean }) {
    useDetailCardScope({ ...refs, present, obscured, dismiss })
    return null
  }
  const key = (type: string, name: string, shiftKey = false) =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent(type, { key: name, shiftKey, bubbles: true, cancelable: true })
    )
  const terminalKeys = vi.fn()
  window.addEventListener('keydown', terminalKeys)
  const mounted: { renderer?: ReactTestRenderer } = {}
  node('terminal').focus()
  act(() => {
    mounted.renderer = create(<Scope present={false} />)
  })
  const renderer = mounted.renderer
  assert(renderer)
  try {
    expect(document.activeElement).toBe(node('terminal'))
    act(() => renderer.update(<Scope present />))
    const later = document.createElement('button')
    node('opener').parentElement?.append(later)
    await vi.waitFor(() => expect(later.getAttribute('aria-hidden')).toBe('true'))
    expect(document.activeElement).toBe(node('card'))
    expect(node('terminal').inert).toBe(true)
    expect(node('status').getAttribute('aria-hidden')).toBe('true')
    key('keydown', 'Tab', true)
    expect(document.activeElement).toBe(node('scroll'))
    key('keydown', 'Tab')
    expect(document.activeElement).toBe(node('opener'))
    key('keydown', 'Tab', true)
    expect(document.activeElement).toBe(node('scroll'))
    higher.focus()
    expect(document.activeElement).toBe(node('card'))
    key('keydown', 'Escape')
    expect(dismiss).not.toHaveBeenCalled()
    key('keyup', 'Escape')
    expect(terminalKeys).not.toHaveBeenCalled()
    act(() => renderer.update(<Scope present={false} />))
    expect(document.activeElement).toBe(node('terminal'))
    act(() => renderer.update(<Scope present />))
    act(() => renderer.update(<Scope present obscured />))
    higher.focus()
    key('keydown', 'Escape')
    key('keyup', 'Escape')
    expect(terminalKeys).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(1)
    act(() => renderer.update(<Scope present={false} obscured />))
    expect(document.activeElement).toBe(higher)
  } finally {
    act(() => renderer.unmount())
    window.removeEventListener('keydown', terminalKeys)
    root.remove()
    higher.remove()
  }
})
