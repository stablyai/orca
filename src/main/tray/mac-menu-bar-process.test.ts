import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MacMenuBarProcess } from './mac-menu-bar-process'
import type { MenuBarSnapshot } from './mac-menu-bar-protocol'

class Helper extends EventEmitter {
  pid = 123
  exitCode: number | null = null
  signalCode: string | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
  requests: { type: string; id: number; snapshot: MenuBarSnapshot }[] = []
  constructor() {
    super()
    this.stdin.on('data', (data) => this.requests.push(JSON.parse(data.toString())))
  }
  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
  exit(): void {
    this.signalCode = 'SIGKILL'
    this.emit('exit', null, 'SIGKILL')
  }
}

const snapshot: MenuBarSnapshot = {
  images: [{ scale: 1, png: 'aWNvbg==' }],
  template: true,
  tooltip: 'instance A',
  menu: [
    { id: 'open', label: 'Open' },
    { id: 'quit', label: 'Quit' }
  ]
}
const owners: MacMenuBarProcess[] = []
const helpers: Helper[] = []
function owner(onAction = vi.fn()) {
  const spawn = vi.fn(() => {
    const helper = new Helper()
    helpers.push(helper)
    return helper
  })
  const process = new MacMenuBarProcess({
    onAction,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every child/stream member used by this owner; no real process is signaled.
    spawn: spawn as unknown as typeof spawnProcess
  })
  owners.push(process)
  process.update(snapshot)
  return { process, onAction, spawn }
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  const exits = owners.splice(0).map((process) => process.destroy())
  for (const helper of helpers.splice(0)) {
    helper.exit()
  }
  await Promise.all(exits)
  vi.useRealTimers()
})

it('keeps latest state through delayed application and a failed helper generation', () => {
  const { process } = owner()
  const first = helpers[0]
  first.send({ type: 'ready' })
  process.update({ ...snapshot, tooltip: 'instance B' })
  process.update({ ...snapshot, tooltip: 'latest' })
  first.send({ type: 'applied', id: first.requests[0].id })
  expect(first.requests.at(-1)?.snapshot.tooltip).toBe('latest')
  first.exit()
  vi.advanceTimersByTime(1_000)
  const replacement = helpers[1]
  replacement.send({ type: 'ready' })
  expect(replacement.requests[0].snapshot.tooltip).toBe('latest')
})

it('routes fresh offered actions to their own parent and ignores duplicates or retired output', () => {
  const a = owner()
  const b = owner()
  const [first, second] = helpers
  for (const helper of [first, second]) {
    helper.send({ type: 'ready' })
    helper.send({ type: 'applied', id: helper.requests[0].id })
  }
  first.send({ type: 'action', sequence: 1, action: 'open' })
  first.send({ type: 'action', sequence: 1, action: 'open' })
  first.send({ type: 'action', sequence: 2, action: 'quit-completely' })
  expect(a.onAction.mock.calls).toEqual([['open']])
  expect(b.onAction).not.toHaveBeenCalled()
  void a.process.destroy()
  first.send({ type: 'action', sequence: 3, action: 'quit' })
  second.send({ type: 'action', sequence: 1, action: 'quit' })
  expect(a.onAction.mock.calls).toEqual([['open']])
  expect(b.onAction.mock.calls).toEqual([['quit']])
})

it.each(['pipe', 'oversized'])(
  'retires %s faults without commands or overlapping replacement',
  async (fault) => {
    const a = owner()
    const first = helpers[0]
    if (fault === 'pipe') {
      first.stdin.emit('error', new Error('EPIPE'))
    } else {
      first.stdout.write('x'.repeat(300_000))
    }
    expect(first.kill).toHaveBeenCalledWith('SIGKILL')
    vi.advanceTimersByTime(60_000)
    expect(a.spawn).toHaveBeenCalledOnce()
    let observed = false
    const retirement = a.process.destroy().then(() => {
      observed = true
    })
    await Promise.resolve()
    expect(observed).toBe(false)
    first.exit()
    await retirement
    vi.advanceTimersByTime(60_000)
    expect(a.spawn).toHaveBeenCalledOnce()
    expect(a.onAction).not.toHaveBeenCalled()
  }
)

it('replaces a helper that misses a state reply, not while asleep', () => {
  const { process } = owner()
  const helper = helpers[0]
  helper.send({ type: 'ready' })
  helper.send({ type: 'applied', id: helper.requests[0].id })
  process.deadline.suspend()
  process.update({ ...snapshot, tooltip: 'during sleep' })
  vi.advanceTimersByTime(60_000)
  expect(helper.kill).not.toHaveBeenCalled()
  process.deadline.resume()
  vi.advanceTimersByTime(16_000)
  expect(helper.kill).toHaveBeenCalledWith('SIGKILL')
})

it('keeps a helper whose open menu defers an update', () => {
  const { process } = owner()
  const helper = helpers[0]
  helper.send({ type: 'ready' })
  helper.send({ type: 'applied', id: helper.requests[0].id })
  process.update({ ...snapshot, tooltip: 'while the menu is open' })
  helper.send({ type: 'deferred', id: helper.requests.at(-1)!.id })
  vi.advanceTimersByTime(60_000)
  expect(helper.kill).not.toHaveBeenCalled()
})

it('replaces a hung helper on the next probe and keeps no timer while idle', () => {
  const { process } = owner()
  const helper = helpers[0]
  helper.send({ type: 'ready' })
  helper.send({ type: 'applied', id: helper.requests[0].id })
  vi.advanceTimersByTime(60 * 60_000)
  expect(vi.getTimerCount()).toBe(0)
  expect(helper.requests.some((request) => request.type === 'ping')).toBe(false)
  process.probe()
  const ping = helper.requests.at(-1)!
  expect(ping.type).toBe('ping')
  helper.send({ type: 'pong', id: ping.id })
  expect(vi.getTimerCount()).toBe(0)
  process.probe()
  vi.advanceTimersByTime(16_000)
  expect(helper.kill).toHaveBeenCalledWith('SIGKILL')
})

function failingOwner(onUnavailable: (reason: 'fallback' | 'off') => void) {
  const spawn = vi.fn(() => {
    const helper = new Helper()
    helpers.push(helper)
    return helper
  })
  const process = new MacMenuBarProcess({
    onAction: vi.fn(),
    onUnavailable,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every child/stream member used by this owner; no real process is signaled.
    spawn: spawn as unknown as typeof spawnProcess
  })
  owners.push(process)
  process.update(snapshot)
  return spawn
}

it('falls back in-process only when helpers never start', () => {
  const onUnavailable = vi.fn()
  const spawn = failingOwner(onUnavailable)
  for (let attempt = 0; attempt < 3; attempt++) {
    helpers.at(-1)!.exit()
    vi.advanceTimersByTime(60_000)
  }
  expect(spawn).toHaveBeenCalledTimes(3)
  expect(onUnavailable.mock.calls).toEqual([['fallback']])
  expect(vi.getTimerCount()).toBe(0)
})

it('turns the icon off, never in-process, when started helpers keep hanging', () => {
  const onUnavailable = vi.fn()
  failingOwner(onUnavailable)
  for (let attempt = 0; attempt < 3; attempt++) {
    const helper = helpers.at(-1)!
    helper.send({ type: 'ready' })
    vi.advanceTimersByTime(16_000)
    expect(helper.kill).toHaveBeenCalledWith('SIGKILL')
    helper.exit()
    // Only the back-off delay: a helper that lived over a minute would count as healthy.
    vi.advanceTimersByTime(5_000)
  }
  expect(onUnavailable.mock.calls).toEqual([['off']])
})

it('forces its owned child during immediate parent exit without waiting for helper execution', async () => {
  const before = new Set(process.listeners('exit'))
  const owned = owner()
  const child = helpers[0]
  const forceExit = process.listeners('exit').find((listener) => !before.has(listener))!
  forceExit(0)
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  const retirement = owned.process.destroy()
  child.exit()
  await retirement
  expect(process.listeners('exit')).not.toContain(forceExit)
})
