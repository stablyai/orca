import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateSettingsRows, type AppUpdateCheckRowStatus } from './app-update-settings-rows'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

const NOW = Date.UTC(2026, 8, 28, 12)
const HOUR = 60 * 60 * 1000

describe('AppUpdateSettingsRows', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(opts: {
    available?: { version: string; url: string } | null
    lastCheckedAt?: number | null
    checkStatus?: AppUpdateCheckRowStatus
  }) {
    const onUpdate = vi.fn()
    const onCheck = vi.fn()
    act(() => {
      renderer = create(
        createElement(AppUpdateSettingsRows, {
          installedVersion: '0.0.48',
          available: opts.available ?? null,
          lastCheckedAt: opts.lastCheckedAt ?? null,
          now: NOW,
          checkStatus: opts.checkStatus ?? 'idle',
          onUpdate,
          onCheck
        })
      )
    })
    const root = renderer!.root
    const texts = root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
    return {
      root,
      texts,
      onUpdate,
      onCheck,
      pressables: root.findAll((node) => String(node.type) === 'Pressable')
    }
  }

  it('offers the known update as a tappable row with an Update action', () => {
    const { texts, pressables, onUpdate } = render({
      available: { version: '0.0.51', url: 'https://example.test' },
      lastCheckedAt: NOW - 2 * HOUR
    })
    expect(texts).toEqual([
      'Update to Orca 0.0.51',
      'Update',
      'Check for updates',
      'Last checked 2h ago'
    ])
    act(() => pressables[0].props.onPress())
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('shows a plain, untappable version row when current, and Never before a first success', () => {
    const { texts, pressables } = render({})
    expect(texts).toEqual(['Version 0.0.48', 'Check for updates', 'Never'])
    expect(pressables).toHaveLength(1)
    expect(pressables[0].props.accessibilityLabel).toBe('Check for updates, Never')
  })

  it('runs the check from its row and shows the transient outcome in place', () => {
    const idle = render({ lastCheckedAt: NOW - 30_000 })
    expect(idle.texts.at(-1)).toBe('Last checked just now')
    act(() => idle.pressables[0].props.onPress())
    expect(idle.onCheck).toHaveBeenCalledTimes(1)
    act(() => renderer?.unmount())
    expect(render({ checkStatus: 'checking' }).pressables[0].props.disabled).toBe(true)
    act(() => renderer?.unmount())
    expect(render({ checkStatus: 'up-to-date' }).texts.at(-1)).toBe('Up to date')
    act(() => renderer?.unmount())
    expect(render({ checkStatus: 'failed' }).texts.at(-1)).toBe("Couldn't check")
  })
})
