import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { trackSshConnectionChannelLifetime } from './ssh-connection-channel-lifetime'

it('removes its error listener when the channel closes', () => {
  const channel = new EventEmitter()
  trackSshConnectionChannelLifetime(channel)
  expect(channel.listenerCount('error')).toBe(1)
  channel.emit('close')
  expect(channel.listenerCount('error')).toBe(0)
})

it.each([undefined, null, {}, { on: () => {} }])('ignores an untrackable value (%s)', (value) => {
  expect(() => trackSshConnectionChannelLifetime(value)).not.toThrow()
})

it('reports a channel error that nothing else handles instead of hiding it', () => {
  const report = vi.fn()
  const channel = new EventEmitter()
  trackSshConnectionChannelLifetime(channel, report)
  const failure = new Error('channel reset')
  expect(() => channel.emit('error', failure)).not.toThrow()
  expect(report).toHaveBeenCalledWith(failure)
})

it('leaves a channel error to the owner that handles it', () => {
  const report = vi.fn()
  const channel = new EventEmitter()
  trackSshConnectionChannelLifetime(channel, report)
  const owner = vi.fn()
  channel.on('error', owner)
  channel.emit('error', new Error('handled'))
  expect(owner).toHaveBeenCalledOnce()
  expect(report).not.toHaveBeenCalled()
})

it('logs an unhandled channel error with the [ssh] prefix when no reporter is given', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const channel = new EventEmitter()
  trackSshConnectionChannelLifetime(channel)
  channel.emit('error', new Error('orphaned'))
  expect(warn).toHaveBeenCalledWith('[ssh] Unhandled SSH channel error: orphaned')
  warn.mockRestore()
})
