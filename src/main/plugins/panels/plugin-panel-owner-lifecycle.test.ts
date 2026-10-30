import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  bindPluginPanelOwnerLifecycle,
  type PluginPanelOwnerSender
} from './plugin-panel-owner-lifecycle'

describe('bindPluginPanelOwnerLifecycle', () => {
  it('deduplicates hooks, revokes on renderer loss, and invalidates in-flight loads', () => {
    const sender = new EventEmitter() as PluginPanelOwnerSender & EventEmitter
    const revoke = vi.fn()
    const first = bindPluginPanelOwnerLifecycle(sender, revoke)
    const duplicate = bindPluginPanelOwnerLifecycle(sender, revoke)

    expect(sender.listenerCount('destroyed')).toBe(1)
    expect(sender.listenerCount('render-process-gone')).toBe(1)
    expect(first.isCurrent()).toBe(true)
    expect(duplicate.isCurrent()).toBe(true)

    sender.emit('render-process-gone')

    expect(revoke).toHaveBeenCalledTimes(1)
    expect(first.isCurrent()).toBe(false)
    expect(duplicate.isCurrent()).toBe(false)
    expect(sender.listenerCount('destroyed')).toBe(0)

    const restarted = bindPluginPanelOwnerLifecycle(sender, revoke)
    expect(restarted.isCurrent()).toBe(true)
    sender.emit('destroyed')
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(restarted.isCurrent()).toBe(false)
  })
})
