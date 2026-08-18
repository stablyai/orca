import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { SshConnectionCallbacks } from './ssh-connection'
import type { SshResolvedConfig } from './ssh-config-parser'
import type { SshTarget } from '../../shared/ssh-types'

export function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

export function createResolvedConfig(overrides?: Partial<SshResolvedConfig>): SshResolvedConfig {
  return {
    hostname: 'example.com',
    port: 22,
    identityFile: [],
    forwardAgent: false,
    identitiesOnly: false,
    proxyUseFdpass: true,
    controlMaster: 'no',
    controlPersist: 'no',
    userKnownHostsFiles: [],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask',
    hashKnownHosts: false,
    updateHostKeys: 'no',
    ...overrides
  }
}

export function createCallbacks(
  overrides?: Partial<SshConnectionCallbacks>
): SshConnectionCallbacks {
  return {
    onStateChange: vi.fn(),
    ...overrides
  }
}

export type MockSystemCommandChannel = EventEmitter & {
  stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
  close: ReturnType<typeof vi.fn>
}

export type MockSystemSshProcess = {
  stdin: object
  stdout: EventEmitter
  stderr: EventEmitter
  kill: Mock<() => void>
  onExit: Mock<(handler: (exitCode: number | null) => void) => void>
  pid: number
}

export function createSystemCommandChannel(): MockSystemCommandChannel {
  const channel = new EventEmitter() as MockSystemCommandChannel
  channel.stdin = { end: vi.fn(), write: vi.fn() }
  channel.stderr = new EventEmitter()
  channel.close = vi.fn()
  queueMicrotask(() => {
    channel.emit('data', Buffer.from('ORCA-SYSTEM-SSH-OK'))
    channel.emit('close', 0)
  })
  return channel
}

export function createFailingSystemCommandChannel(
  code: number,
  stderrText = ''
): MockSystemCommandChannel {
  const channel = new EventEmitter() as MockSystemCommandChannel
  channel.stdin = { end: vi.fn(), write: vi.fn() }
  channel.stderr = new EventEmitter()
  channel.close = vi.fn()
  queueMicrotask(() => {
    if (stderrText) {
      channel.stderr.emit('data', Buffer.from(stderrText))
    }
    channel.emit('close', code)
  })
  return channel
}

// A probe that never answers — the shape a FIDO2/system-transport host takes when the network drops.
export function createHangingSystemCommandChannel(): MockSystemCommandChannel {
  const channel = new EventEmitter() as MockSystemCommandChannel
  channel.stdin = { end: vi.fn(), write: vi.fn() }
  channel.stderr = new EventEmitter()
  channel.close = vi.fn()
  return channel
}

export function createPendingSystemSshProcess(): MockSystemSshProcess {
  const stdout = new EventEmitter()
  return {
    stdin: {},
    stdout,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    onExit: vi.fn(),
    pid: 99999
  }
}

export function createSystemSshProcess(): MockSystemSshProcess {
  const proc = createPendingSystemSshProcess()
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from('ORCA-SYSTEM-SSH-READY'))
  })
  return proc
}

export function createFailingSystemSshProcess(code: number): MockSystemSshProcess {
  const proc = createPendingSystemSshProcess()
  proc.onExit = vi.fn((handler: (exitCode: number | null) => void) => {
    queueMicrotask(() => handler(code))
  })
  return proc
}
