import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT } from '../../shared/plugins/plugin-sidecar-contract'
import { PluginSidecarMailbox } from './plugin-sidecar-mailbox'

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginSidecarMailbox', () => {
  it('isolates frames per plugin and replaces the same channel', () => {
    const mailbox = new PluginSidecarMailbox()
    mailbox.publish('orca-samples.one', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'first' }
    })
    mailbox.publish('orca-samples.two', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'other' }
    })
    mailbox.publish('orca-samples.one', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'second' }
    })

    expect(mailbox.latest('orca-samples.one')).toEqual([
      expect.objectContaining({
        pluginKey: 'orca-samples.one',
        payload: { details: 'second' },
        op: 'set'
      })
    ])
    expect(mailbox.latest('orca-samples.two')).toHaveLength(1)
    expect(mailbox.latest()).toHaveLength(2)
  })

  it('stores a clear frame without a payload', () => {
    const mailbox = new PluginSidecarMailbox()
    mailbox.publish('orca-samples.one', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'live' }
    })
    mailbox.publish('orca-samples.one', { channel: 'presence', op: 'clear' })

    expect(mailbox.latest('orca-samples.one')).toEqual([
      expect.objectContaining({
        op: 'clear',
        payload: null
      })
    ])
  })

  it('evicts the oldest slot when the mailbox is full', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const mailbox = new PluginSidecarMailbox()
    mailbox.publish('orca-samples.first', {
      channel: 'generic',
      op: 'set',
      payload: { n: 0 }
    })
    for (let index = 1; index < PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT; index += 1) {
      vi.setSystemTime(1_000 + index)
      mailbox.publish(`orca-samples.p${index}`, {
        channel: 'generic',
        op: 'set',
        payload: { n: index }
      })
    }
    expect(mailbox.latest()).toHaveLength(PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT)

    vi.setSystemTime(50_000)
    mailbox.publish('orca-samples.newest', {
      channel: 'generic',
      op: 'set',
      payload: { n: 'new' }
    })

    const keys = mailbox.latest().map((frame) => frame.pluginKey)
    expect(keys).not.toContain('orca-samples.first')
    expect(keys).toContain('orca-samples.newest')
    expect(keys).toHaveLength(PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT)
  })

  it('evicts the first published frame when timestamps tie', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const mailbox = new PluginSidecarMailbox()
    mailbox.publish('orca-samples.zzz', {
      channel: 'generic',
      op: 'set',
      payload: { n: 'first' }
    })
    for (let index = 1; index < PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT; index += 1) {
      mailbox.publish(`orca-samples.p${index}`, {
        channel: 'generic',
        op: 'set',
        payload: { n: index }
      })
    }
    mailbox.publish('orca-samples.aaa', {
      channel: 'generic',
      op: 'set',
      payload: { n: 'new' }
    })

    const keys = mailbox.latest().map((frame) => frame.pluginKey)
    expect(keys).not.toContain('orca-samples.zzz')
    expect(keys).toContain('orca-samples.aaa')
    expect(keys).toHaveLength(PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT)
  })

  it('exposes lastPublishedAt for the requesting plugin only', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10)
    const mailbox = new PluginSidecarMailbox()
    mailbox.publish('orca-samples.one', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'a' }
    })
    vi.setSystemTime(20)
    mailbox.publish('orca-samples.two', {
      channel: 'presence',
      op: 'set',
      payload: { details: 'b' }
    })

    expect(mailbox.resolvePlacement('orca-samples.one').lastPublishedAt).toBe(10)
    expect(mailbox.resolvePlacement('orca-samples.two').lastPublishedAt).toBe(20)
    expect(mailbox.resolvePlacement().lastPublishedAt).toBe(20)
    expect(mailbox.resolvePlacement('orca-samples.missing').lastPublishedAt).toBeNull()
  })
})
