// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { applySinglePaneCapVariables } from './single-pane-cap-variables'

describe('single-pane cap variables', () => {
  it('publishes a px cap and a visible edge', () => {
    const root = document.createElement('div')
    applySinglePaneCapVariables(root, 1100)
    expect(root.style.getPropertyValue('--pane-single-max-width')).toBe('1100px')
    expect(root.style.getPropertyValue('--pane-single-edge-width')).toBe('1px')
  })

  it('maps 0 to none so the pane is not collapsed, and hides the edge', () => {
    const root = document.createElement('div')
    applySinglePaneCapVariables(root, 0)
    expect(root.style.getPropertyValue('--pane-single-max-width')).toBe('none')
    expect(root.style.getPropertyValue('--pane-single-edge-width')).toBe('0px')
  })

  it('clears both properties when unset, so the stylesheet default applies', () => {
    const root = document.createElement('div')
    applySinglePaneCapVariables(root, 900)
    applySinglePaneCapVariables(root, undefined)
    expect(root.style.getPropertyValue('--pane-single-max-width')).toBe('')
    expect(root.style.getPropertyValue('--pane-single-edge-width')).toBe('')
  })
})
