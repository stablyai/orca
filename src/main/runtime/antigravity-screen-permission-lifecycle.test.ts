import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'
import { AntigravityScreenPermissionPublisher } from './antigravity-screen-permission-publisher'

let ready: RuntimeVisibleTerminalState
const baseline: AgentStatusIpcPayload = {
  paneKey: 'tab:leaf',
  agentType: 'antigravity',
  state: 'waiting',
  prompt: '',
  connectionId: null,
  receivedAt: 1,
  stateStartedAt: 1
}
beforeAll(async () => {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  try {
    await new Promise<void>((resolve) =>
      terminal.write(
        readFileSync(join(__dirname, '__fixtures__/antigravity-1-2-14-ready.txt'), 'utf8'),
        resolve
      )
    )
    const buffer = terminal.buffer.active
    ready = {
      lines: Array.from(
        { length: 40 },
        (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
      ).filter((line) => line.trim()),
      generation: 1,
      sequence: 1,
      isAlternateScreen: true
    }
  } finally {
    terminal.dispose()
  }
})
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

async function flushReads(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

function deferredPublisher() {
  const first = Promise.withResolvers<RuntimeVisibleTerminalState | null>()
  const second = Promise.withResolvers<RuntimeVisibleTerminalState | null>()
  const readScreen = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(ready)
  const publish = vi.fn(() => true)
  let remaining = 3000
  const publisher = new AntigravityScreenPermissionPublisher({
    baseline: () => baseline,
    readScreen,
    isCurrent: () => true,
    quietRemainingMs: () => remaining,
    publish
  })
  return {
    first,
    second,
    readScreen,
    publish,
    publisher,
    setRemaining: (value: number) => {
      remaining = value
    }
  }
}

it('keeps one quiet timer when output dirties a pending screen read', async () => {
  const fixture = deferredPublisher()
  fixture.publisher.schedule('pty')
  fixture.publisher.schedule('pty')
  fixture.first.resolve(ready)
  await flushReads()
  expect(fixture.readScreen).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  fixture.setRemaining(5000)
  fixture.second.resolve(ready)
  await flushReads()
  expect(vi.getTimerCount()).toBe(1)
  fixture.publisher.forget('pty')
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(6000)
  expect(fixture.readScreen).toHaveBeenCalledTimes(2)
  expect(fixture.publish).not.toHaveBeenCalled()
})

it('a forgotten pending read cannot publish or arm a timer', async () => {
  const fixture = deferredPublisher()
  fixture.publisher.schedule('pty')
  fixture.publisher.forget('pty')
  fixture.first.resolve(ready)
  await flushReads()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(6000)
  expect(fixture.readScreen).toHaveBeenCalledTimes(1)
  expect(fixture.publish).not.toHaveBeenCalled()
})

it('old read cleanup cannot consume a replacement PTY pending read or timer', async () => {
  const fixture = deferredPublisher()
  fixture.publisher.schedule('pty')
  fixture.publisher.forget('pty')
  fixture.publisher.schedule('pty')
  expect(fixture.readScreen).toHaveBeenCalledTimes(2)
  fixture.second.resolve(ready)
  await flushReads()
  expect(vi.getTimerCount()).toBe(1)
  fixture.first.resolve(ready)
  await flushReads()
  expect(vi.getTimerCount()).toBe(1)
  fixture.setRemaining(0)
  await vi.advanceTimersByTimeAsync(3000)
  expect(fixture.readScreen).toHaveBeenCalledTimes(3)
  expect(fixture.publish).toHaveBeenCalledExactlyOnceWith({
    baseline,
    command: null,
    clearedState: 'done'
  })
  fixture.publisher.forget('pty')
  expect(vi.getTimerCount()).toBe(0)
})
