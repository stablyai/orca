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

  // Why: animationstart fires on the first start and on every restart (class
  // re-add, display:none reveal), so it alone keeps every ring phase-locked.
  // A negative animation-delay cannot — it is static, so a restart replays the
  // stale mount-time offset and the rings fan out across steps.
  it('anchors every animation start to the shared document epoch', async () => {
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
    const fireAnimationStart = async (): Promise<void> => {
      const event = new Event('animationstart', { bubbles: true })
      Object.defineProperty(event, 'animationName', { value: 'agent-spinner-rotate' })
      await act(async () => {
        container.querySelector('[data-agent-spinner]')!.dispatchEvent(event)
      })
    }

    try {
      await act(async () => {
        root.render(<AgentWorkingSpinner />)
      })
      // Why: mount must not query animations — that forces a synchronous style
      // recalc per ring for a phase the first animationstart sets anyway.
      expect(getAnimations).not.toHaveBeenCalled()

      await fireAnimationStart()
      expect(animation.startTime).toBe(0)

      animation.startTime = 654
      await fireAnimationStart()
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

  // Why: reduced motion resolves the rule to `animation: none`, so no animation
  // exists to start and none to anchor. Pins that dropping the ref-time anchor
  // adds no exposure here — both paths were already no-ops.
  it('anchors nothing when reduced motion leaves no animation to start', async () => {
    const getAnimations = vi.fn(() => [] as Animation[])
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
      const el = container.querySelector('[data-agent-spinner]')

      expect(el).not.toBeNull()
      expect(getAnimations).not.toHaveBeenCalled()
      expect(el!.className).toContain('motion-reduce:border-t-yellow-500')
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

  it('ignores animation starts from other animations on the same element', async () => {
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
      const unrelated = new Event('animationstart', { bubbles: true })
      Object.defineProperty(unrelated, 'animationName', { value: 'compact-agent-expansion-reveal' })
      await act(async () => {
        container.querySelector('[data-agent-spinner]')!.dispatchEvent(unrelated)
      })

      expect(getAnimations).not.toHaveBeenCalled()
      expect(animation.startTime).toBe(321)
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
