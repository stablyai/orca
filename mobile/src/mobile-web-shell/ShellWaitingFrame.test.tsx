import { createElement } from 'react'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

const fades = vi.hoisted(() => {
  const animations: {
    target: number
    stops: number
    done?: (result: { finished: boolean }) => void
  }[] = []
  return { animations }
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Easing: { in: (fn: unknown) => fn, quad: 'quad' },
  Animated: {
    View: 'Animated.View',
    Value: class {
      setValue(): void {}
    },
    timing: (_value: unknown, options: { toValue: number }) => {
      const animation: {
        target: number
        stops: number
        done?: (result: { finished: boolean }) => void
      } = { target: options.toValue, stops: 0 }
      fades.animations.push(animation)
      return {
        start: (done?: (result: { finished: boolean }) => void) => {
          animation.done = done
        },
        stop: () => {
          animation.stops += 1
        }
      }
    }
  },
  StyleSheet: {
    create: (styles: unknown) => styles,
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
  },
  Text: 'Text',
  View: 'View'
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
  it('goes once the page reports a frame', () => {
    const tree = render(true)
    act(() => {
      tree.update(createElement(ShellPageCover, { label: 'Opening workspace', visible: false }))
    })
    expect(cover(tree)).not.toBeNull()
    const animation = fades.animations.at(-1)
    if (animation?.done === undefined) {
      throw new Error('fade never started')
    }
    expect(animation.target).toBe(0)
    act(() => animation.done?.({ finished: true }))
    expect(cover(tree)).toBeNull()
  })

  it('keeps an interrupted fade inert while targeting zero opacity', () => {
    const tree = render(true)
    act(() =>
      tree.update(createElement(ShellPageCover, { label: 'Opening workspace', visible: false }))
    )
    const animation = fades.animations.at(-1)
    if (animation?.done === undefined) {
      throw new Error('fade never started')
    }
    expect(animation.target).toBe(0)
    act(() => animation.done?.({ finished: false }))
    expect(cover(tree)?.props.pointerEvents).toBe('none')
  })

  it('stops the pending fade when its view unmounts', () => {
    const tree = render(true)
    act(() =>
      tree.update(createElement(ShellPageCover, { label: 'Opening workspace', visible: false }))
    )
    const animation = fades.animations.at(-1)
    if (animation?.done === undefined) {
      throw new Error('fade never started')
    }
    const before = animation.stops
    act(() => tree.unmount())
    expect(animation.stops).toBe(before + 1)
  })
})

afterEach(() => {
  unmountRenderers()
  fades.animations.length = 0
})
