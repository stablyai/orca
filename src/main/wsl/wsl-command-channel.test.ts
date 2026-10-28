import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import {
  killWslChannelsInCloseGrace,
  WSL_CHANNEL_CLOSE_GRACE_MS,
  wrapWslCommandProcess
} from './wsl-command-channel'

const nullCode: number | null = null
const nullSignal: NodeJS.Signals | null = null

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: nullCode,
    signalCode: nullSignal,
    kill: vi.fn(() => true)
  })
  const exit = (code: number): void => {
    child.exitCode = code
    child.emit('exit', code, null)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the channel reads only these members.
  return { child: child as unknown as PipedChildProcess, fake: child, exit }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it('ends stdin first, so a guest that exits on EOF ends its WSL session cleanly', () => {
  const { child, fake, exit } = fakeChild()
  wrapWslCommandProcess(child).close()
  expect(fake.stdin.writableEnded).toBe(true)
  exit(0)
  vi.advanceTimersByTime(WSL_CHANNEL_CLOSE_GRACE_MS)
  expect(fake.kill).not.toHaveBeenCalled()
})

it('kills wsl.exe when the guest ignores EOF past the grace period', () => {
  const { child, fake } = fakeChild()
  wrapWslCommandProcess(child).close()
  vi.advanceTimersByTime(WSL_CHANNEL_CLOSE_GRACE_MS - 1)
  expect(fake.kill).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(fake.kill).toHaveBeenCalledOnce()
})

it('does nothing once wsl.exe already exited', () => {
  const { child, fake, exit } = fakeChild()
  const channel = wrapWslCommandProcess(child)
  exit(0)
  channel.close()
  vi.advanceTimersByTime(WSL_CHANNEL_CLOSE_GRACE_MS)
  expect(fake.kill).not.toHaveBeenCalled()
})

it('kills a channel still in its grace at app quit, and only once', () => {
  const closing = fakeChild()
  const open = fakeChild()
  wrapWslCommandProcess(closing.child).close()
  wrapWslCommandProcess(open.child)
  killWslChannelsInCloseGrace()
  expect(closing.fake.kill).toHaveBeenCalledOnce()
  // An open channel is not ours to end at quit through this path.
  expect(open.fake.kill).not.toHaveBeenCalled()
  vi.advanceTimersByTime(WSL_CHANNEL_CLOSE_GRACE_MS)
  expect(closing.fake.kill).toHaveBeenCalledOnce()
})
