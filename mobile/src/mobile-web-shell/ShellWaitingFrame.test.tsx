import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { colors } from '../theme/mobile-theme'

const fades = vi.hoisted(() => ({ stops: 0, finished: true }))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    View: 'Animated.View',
    Value: class {
      setValue(): void {}
    },
    timing: () => ({
      start: (done?: (result: { finished: boolean }) => void) => {
        done?.({ finished: fades.finished })
      },
      stop: () => {
        fades.stops += 1
      }
    })
  },
  StyleSheet: {
    create: (styles: unknown) => styles,
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
  },
  Text: 'Text'
}))

const { ShellPageCover } = await import('./ShellWaitingFrame')

function render(visible: boolean): ReactTestRenderer {
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(createElement(ShellPageCover, { label: 'Opening workspace', visible }))
  })
  if (tree === null) {
    throw new Error('the cover never rendered')
  }
  return tree
}

function cover(tree: ReactTestRenderer) {
  return tree.root.findAllByProps({ testID: 'mobile-web-shell-cover' })[0] ?? null
}

describe('the frame the shell keeps over an unpainted page', () => {
  it('is up while the page has not painted', () => {
    const tree = render(true)
    expect(cover(tree)).not.toBeNull()
  })

  it('paints the app surface and never black, so an empty view is never a hole', () => {
    // The whole defect in one assertion: what shows while the WebView draws nothing is this.
    const held = cover(render(true))
    const style = held?.props.style as readonly Record<string, unknown>[]
    expect(style[0]?.backgroundColor).toBe(colors.bgBase)
    expect(style[0]?.backgroundColor).not.toBe('#000000')
  })

  it('never takes a touch, so a report that never lands leaves a usable page under it', () => {
    expect(cover(render(true))?.props.pointerEvents).toBe('none')
  })

  it('goes once the page reports a frame', () => {
    const tree = render(true)
    act(() => {
      tree.update(createElement(ShellPageCover, { label: 'Opening workspace', visible: false }))
    })
    expect(cover(tree)).toBeNull()
  })

  it('stays out of the way when a fade is cut short rather than staying opaque', () => {
    // A platform that stops the fade reports `finished: false`; the cover keeps its element and
    // its `pointerEvents: none`, which is a transparent inert layer rather than an opaque one.
    fades.finished = false
    const tree = render(true)
    act(() => {
      tree.update(createElement(ShellPageCover, { label: 'Opening workspace', visible: false }))
    })
    expect(cover(tree)?.props.pointerEvents).toBe('none')
    fades.finished = true
  })

  it('stops a fade in flight when the view unmounts', () => {
    const before = fades.stops
    const tree = render(false)
    act(() => {
      tree.unmount()
    })
    expect(fades.stops).toBeGreaterThan(before)
  })
})
