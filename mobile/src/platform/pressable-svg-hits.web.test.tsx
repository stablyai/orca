// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => vi.importActual<typeof import('react-native')>('react-native-web'))

import { Pressable, View } from 'react-native'
import { startIgnoringPressableIconHits } from './pressable-svg-hits.web'

function icon(name: string) {
  return createElement('svg', { 'data-icon': name }, createElement('path', { d: 'M1 1' }))
}

describe('page pressable icon hits', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    container?.remove()
    document.getElementById('orca-pressable-svg-hits')?.remove()
    root = undefined
    container = undefined
  })

  it('runs onPress for a click on the icon path and leaves a deep drawing hittable', async () => {
    startIgnoringPressableIconHits()
    const onPress = vi.fn()
    const onWrapped = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <>
          <Pressable accessibilityLabel="Send" onPress={onPress}>
            {icon('send')}
          </Pressable>
          <Pressable accessibilityLabel="Wrapped" onPress={onWrapped}>
            <View>{icon('wrapped')}</View>
          </Pressable>
          <Pressable accessibilityLabel="Diagram">
            <View>
              <View>
                <View>{icon('diagram')}</View>
              </View>
            </View>
          </Pressable>
          {icon('loose')}
        </>
      )
    })
    const button = container.querySelector('[aria-label="Send"]')
    const wrapped = container.querySelector('[aria-label="Wrapped"]')
    if (!(button instanceof HTMLElement) || !(wrapped instanceof HTMLElement)) {
      throw new Error('Icon buttons are missing')
    }
    const path = button.querySelector('path')
    const wrappedPath = wrapped.querySelector('path')
    if (!(path instanceof SVGPathElement) || !(wrappedPath instanceof SVGPathElement)) {
      throw new Error('Icon paths are missing')
    }
    const svg = path.ownerSVGElement
    const wrappedSvg = wrappedPath.ownerSVGElement
    if (!(svg instanceof SVGElement) || !(wrappedSvg instanceof SVGElement)) {
      throw new Error('Icons are missing')
    }
    expect(button.hasAttribute('aria-disabled')).toBe(false)
    expect(getComputedStyle(svg).pointerEvents).toBe('none')
    expect(getComputedStyle(path).pointerEvents).toBe('none')
    expect(getComputedStyle(wrappedSvg).pointerEvents).toBe('none')
    expect(getComputedStyle(wrappedPath).pointerEvents).toBe('none')
    const diagram = container.querySelector('[data-icon="diagram"]')
    const loose = container.querySelector('[data-icon="loose"]')
    if (!(diagram instanceof SVGElement) || !(loose instanceof SVGElement)) {
      throw new Error('Control drawings are missing')
    }
    expect(getComputedStyle(diagram).pointerEvents).not.toBe('none')
    expect(getComputedStyle(loose).pointerEvents).not.toBe('none')
    await act(async () => {
      path.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      wrappedPath.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(onWrapped).toHaveBeenCalledTimes(1)
  })
})
