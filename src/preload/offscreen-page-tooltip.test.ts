// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { installTooltipReporter, tooltipForNode } from './offscreen-page-tooltip'

function html(markup: string): HTMLElement {
  document.body.innerHTML = markup
  return document.body
}

describe('tooltipForNode', () => {
  it('uses the nearest title, and an empty title hides an outer one', () => {
    const body = html(
      '<div title="outer"><span id="a">x</span><p title=""><b id="b">y</b></p></div>'
    )
    expect(tooltipForNode(body.querySelector('#a'))).toBe('outer')
    expect(tooltipForNode(body.querySelector('#b'))).toBe('')
    expect(tooltipForNode(body.querySelector('#a')?.firstChild ?? null)).toBe('outer')
  })

  it('reads an SVG element title from its <title> child', () => {
    const body = html('<svg><g><title>chart bar</title><rect id="r"></rect></g></svg>')
    expect(tooltipForNode(body.querySelector('#r'))).toBe('chart bar')
  })

  it('walks out of shadow roots to the host', () => {
    const body = html('<div id="host" title="from host"></div>')
    const root = body.querySelector('#host')?.attachShadow({ mode: 'open' })
    const inner = document.createElement('span')
    root?.append(inner)
    expect(tooltipForNode(inner)).toBe('from host')
  })

  it('falls back to a form control default tooltip', () => {
    const body = html('<input id="f" type="file"><form novalidate><input id="n" required></form>')
    expect(tooltipForNode(body.querySelector('#f'))).toBe('No file chosen')
    expect(tooltipForNode(body.querySelector('#n'))).toBe('')
  })
})

describe('installTooltipReporter', () => {
  it('reports only changes, and again after the pointer comes back', () => {
    const body = html('<p id="a" title="A">a</p><p id="b">b</p>')
    const report = vi.fn()
    installTooltipReporter(report)
    const move = (id: string) =>
      body.querySelector(`#${id}`)?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    move('a')
    move('a')
    move('b')
    document.dispatchEvent(new MouseEvent('mouseleave'))
    move('b')
    expect(report.mock.calls).toEqual([['A'], [''], ['']])
  })
})
