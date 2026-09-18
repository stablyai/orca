// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentWorkingEmojiSpinner } from './AgentWorkingEmojiSpinner'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('AgentWorkingEmojiSpinner', () => {
  it('renders the emoji on the compositor-driven CSS animation', () => {
    const markup = renderToStaticMarkup(
      React.createElement(AgentWorkingEmojiSpinner, { emoji: '🎧' })
    )

    expect(markup).toContain('agent-working-emoji-spinner')
    expect(markup).toContain('data-agent-emoji-spinner')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('🎧')
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
        root.render(<AgentWorkingEmojiSpinner emoji="🎧" />)
      })
      expect(container.querySelector('[data-agent-emoji-spinner]')).not.toBeNull()
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

  it('anchors every animation start to the shared document epoch', async () => {
    const animation = {
      animationName: 'agent-working-emoji-rotate',
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
      Object.defineProperty(event, 'animationName', { value: 'agent-working-emoji-rotate' })
      await act(async () => {
        container.querySelector('[data-agent-emoji-spinner]')!.dispatchEvent(event)
      })
    }

    try {
      await act(async () => {
        root.render(<AgentWorkingEmojiSpinner emoji="🎧" />)
      })
      expect(getAnimations).not.toHaveBeenCalled()

      await fireAnimationStart()
      expect(animation.startTime).toBe(0)
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
      animationName: 'agent-working-emoji-rotate',
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
        root.render(<AgentWorkingEmojiSpinner emoji="🎧" />)
      })
      const unrelated = new Event('animationstart', { bubbles: true })
      Object.defineProperty(unrelated, 'animationName', { value: 'compact-agent-expansion-reveal' })
      await act(async () => {
        container.querySelector('[data-agent-emoji-spinner]')!.dispatchEvent(unrelated)
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

  it('disables the rotation under reduced motion', () => {
    const css = readFileSync(join(__dirname, '../assets/main.css'), 'utf8')

    const rule = css.match(/\.agent-working-emoji-spinner\s*\{[^}]*\}/)?.[0]
    expect(rule).toBeDefined()
    expect(rule).toContain('animation: agent-working-emoji-rotate 1.6s linear infinite')
    expect(css).toContain('@keyframes agent-working-emoji-rotate')

    const reducedMotionBlock = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.agent-working-emoji-spinner\s*\{[^}]*\}/
    )?.[0]
    expect(reducedMotionBlock).toContain('animation: none')
  })
})
