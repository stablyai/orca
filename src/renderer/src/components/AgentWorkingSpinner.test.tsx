// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentWorkingSpinner } from './AgentWorkingSpinner'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('AgentWorkingSpinner', () => {
  it('hooks the compositor-driven CSS animation, not a JS clock', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentWorkingSpinner))

    expect(markup).toContain('agent-working-spinner')
    expect(markup).toContain('data-agent-spinner')
    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('border-t-transparent')
    expect(markup).toContain('motion-reduce:border-t-yellow-500')
  })

  it('renders when the Web Animations API is unavailable', async () => {
    const originalGetAnimations = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'getAnimations'
    )
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: undefined
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<AgentWorkingSpinner />)
      })
      expect(container.querySelector('[data-agent-spinner]')).not.toBeNull()
    } finally {
      act(() => root.unmount())
      container.remove()
      if (originalGetAnimations === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations')
      } else {
        Object.defineProperty(HTMLElement.prototype, 'getAnimations', originalGetAnimations)
      }
    }
  })

  it('anchors mount and restart animations to the shared document epoch', async () => {
    const animation = {
      animationName: 'agent-spinner-rotate',
      startTime: 321
    } as unknown as Animation
    const getAnimations = vi.fn(() => [animation])
    const originalGetAnimations = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'getAnimations'
    )
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: getAnimations
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      await act(async () => {
        root.render(<AgentWorkingSpinner />)
      })
      expect(animation.startTime).toBe(0)

      animation.startTime = 654
      const restart = new Event('animationstart', { bubbles: true })
      Object.defineProperty(restart, 'animationName', { value: 'agent-spinner-rotate' })
      await act(async () => {
        container.querySelector('[data-agent-spinner]')!.dispatchEvent(restart)
      })
      expect(animation.startTime).toBe(0)
      expect(getAnimations).toHaveBeenCalledTimes(2)
    } finally {
      act(() => root.unmount())
      container.remove()
      if (originalGetAnimations === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations')
      } else {
        Object.defineProperty(HTMLElement.prototype, 'getAnimations', originalGetAnimations)
      }
    }
  })

  // Why: the class only spins if main.css defines it — pin the wiring across
  // both files so neither side can be renamed or dropped alone (STA-3328
  // regressed typing latency when rotation moved onto the input thread).
  it('is backed by a steps(12) keyframe animation in main.css', () => {
    const css = readFileSync(join(__dirname, '../assets/main.css'), 'utf8')

    const rule = css.match(/\.agent-working-spinner\s*\{[^}]*\}/)?.[0]
    expect(rule).toBeDefined()
    expect(rule).toContain('animation: agent-spinner-rotate 1s steps(12, end) infinite')
    expect(css).toContain('@keyframes agent-spinner-rotate')

    const reducedMotionBlock = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.agent-working-spinner\s*\{[^}]*\}/
    )?.[0]
    expect(reducedMotionBlock).toContain('animation: none')
  })
})
