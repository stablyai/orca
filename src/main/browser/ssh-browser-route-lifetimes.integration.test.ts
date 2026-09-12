import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { Client } from 'ssh2'
import { expect, it, vi } from 'vitest'
import type { SshConnection } from '../ssh/ssh-connection'
import { SystemSshDynamicForwardStartupRetiredError } from '../ssh/system-ssh-dynamic-forward-process'
import {
  resolveSshBrowserNetworkExecutionRoute,
  type SshBrowserNetworkExecutionRouteDependencies
} from './ssh-browser-network-execution-route'
import { assertSshBrowserResourcesAbsent } from './ssh-browser-route-lifetimes'

let sequence = 0
function fixture(client: unknown = null) {
  const targetId = `browser-lifetime-integration-${++sequence}`
  const abort = new AbortController()
  const removeAuthorityAbort = vi.fn()
  const connection = {
    getState: () => ({ status: 'connected' }),
    getClient: () => client,
    usesSystemSshTransport: () => client === null,
    prepareForwardRoute: (open: () => Promise<unknown>) => open(),
    forwardOut: (_client: unknown, _socket: unknown, ...args: Parameters<Client['forwardOut']>) =>
      (client as Client).forwardOut(...args)
  } as unknown as SshConnection
  const dependencies: SshBrowserNetworkExecutionRouteDependencies = {
    connectionManager: { getConnection: () => connection },
    isCurrentAuthority: () => true,
    registerAuthorityAbort: (_authority, controller) => {
      abort.signal.addEventListener('abort', () => controller.abort(), { once: true })
      return removeAuthorityAbort
    }
  }
  const open = () =>
    resolveSshBrowserNetworkExecutionRoute(
      {
        executionHost: {
          kind: 'ssh',
          targetId,
          providerEpoch: 'epoch-a',
          connectionGeneration: 1
        },
        runtimeId: 'runtime-a',
        runtimeRevision: 1
      },
      dependencies
    )
  return { targetId, abort, connection, dependencies, open, removeAuthorityAbort }
}

function forward(close: () => Promise<void>) {
  return {
    process: Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null
    }) as ChildProcess,
    localPort: 12345,
    stderrTail: () => '',
    dispose: vi.fn(),
    close
  }
}

it('retains ssh2 pending opens through abort and synthetic socket close until raw close', async () => {
  let callback: Parameters<Client['forwardOut']>[4] | undefined
  const f = fixture({
    forwardOut: (...args: Parameters<Client['forwardOut']>) => {
      callback = args[4]
    }
  })
  const route = await f.open()
  const socket = route.connect({ host: 'internal', port: 443 })
  socket.on('error', () => {})
  f.abort.abort()
  await route.whenInvalidated
  const closing = route.close()
  expect(route.close()).toBe(closing)
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  const channel = Object.assign(new EventEmitter(), { close: vi.fn() })
  callback!(undefined, channel as never)
  await Promise.resolve()
  expect(channel.close).toHaveBeenCalledOnce()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  channel.emit('close')
  await closing
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).not.toThrow()
})

it('retains system route startup and close despite authority abort', async () => {
  const f = fixture()
  const ready = Promise.withResolvers<ReturnType<typeof forward>>()
  const stopped = Promise.withResolvers<void>()
  f.dependencies.startDynamicForward = () => ready.promise
  const opening = f.open()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  ready.resolve(forward(() => stopped.promise))
  const route = await opening
  f.abort.abort()
  await route.whenInvalidated
  const closing = route.close()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  stopped.resolve()
  await closing
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).not.toThrow()
})

it('retains rejected system close after authority registrations disappear', async () => {
  const f = fixture()
  f.dependencies.startDynamicForward = async () =>
    forward(async () => {
      throw new Error('stop unconfirmed')
    })
  const route = await f.open()
  f.abort.abort()
  const closing = route.close()
  await expect(closing).rejects.toThrow('stop unconfirmed')
  expect(route.close()).toBe(closing)
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
})

it('does not retain unavailable preflight but retains unknown allocated startup failure', async () => {
  const unavailable = fixture()
  unavailable.dependencies.isCurrentAuthority = () => false
  await expect(unavailable.open()).rejects.toThrow('execution_host_unavailable')
  expect(() => assertSshBrowserResourcesAbsent(unavailable.targetId)).not.toThrow()
  const allocated = fixture()
  allocated.dependencies.startDynamicForward = async () => {
    throw new Error('startup unconfirmed')
  }
  await expect(allocated.open()).rejects.toThrow('startup unconfirmed')
  expect(allocated.removeAuthorityAbort).toHaveBeenCalledOnce()
  expect(() => assertSshBrowserResourcesAbsent(allocated.targetId)).toThrow()
})

it.each([false, true])(
  'requires typed startup retirement evidence: confirmed=%s',
  async (confirmed) => {
    const f = fixture()
    const cause = new Error('dynamic forward startup failed')
    const failure = confirmed ? new SystemSshDynamicForwardStartupRetiredError(cause) : cause
    f.dependencies.startDynamicForward = async () => {
      throw failure
    }
    await expect(f.open()).rejects.toThrow(cause.message)
    expect(f.removeAuthorityAbort).toHaveBeenCalledOnce()
    if (confirmed) {
      expect(() => assertSshBrowserResourcesAbsent(f.targetId)).not.toThrow()
    } else {
      expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
    }
  }
)

it.each([false, true])(
  'requires relay retirement beyond drain: confirmed=%s',
  async (confirmed) => {
    const f = fixture()
    const draining = Promise.withResolvers<void>()
    const tunnel = { fail: vi.fn(), retirementConfirmed: false, resetRetirementRequest: undefined }
    f.dependencies.openNetworkTunnel = async () =>
      ({
        connection: f.connection,
        tunnel,
        assertCurrent: () => {},
        assertAdmission: () => {},
        release: () => draining.promise
      }) as unknown as Awaited<ReturnType<NonNullable<typeof f.dependencies.openNetworkTunnel>>>
    const route = await f.open()
    f.abort.abort()
    const closing = route.close()
    expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
    tunnel.retirementConfirmed = confirmed
    draining.resolve()
    await closing
    if (confirmed) {
      expect(() => assertSshBrowserResourcesAbsent(f.targetId)).not.toThrow()
    } else {
      expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
    }
  }
)

it('keeps concurrent same-target routes independent of other targets', async () => {
  const f = fixture({ forwardOut: vi.fn() })
  const other = fixture({ forwardOut: vi.fn() })
  const [first, second, unrelated] = await Promise.all([f.open(), f.open(), other.open()])
  await first.close()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  await unrelated.close()
  expect(() => assertSshBrowserResourcesAbsent(other.targetId)).not.toThrow()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  await second.close()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).not.toThrow()
})

it.each([false, true])('tracks stale startup until close is confirmed=%s', async (confirmed) => {
  const f = fixture()
  const ready = Promise.withResolvers<ReturnType<typeof forward>>()
  const stopped = Promise.withResolvers<void>()
  f.dependencies.startDynamicForward = () => ready.promise
  const opening = f.open()
  f.abort.abort()
  ready.resolve(forward(() => stopped.promise))
  await Promise.resolve()
  expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  const rejection = expect(opening).rejects.toThrow(
    confirmed ? 'execution_host_stale' : 'stop unconfirmed'
  )
  if (confirmed) {
    stopped.resolve()
  } else {
    stopped.reject(new Error('stop unconfirmed'))
  }
  await rejection
  if (confirmed) {
    expect(() => assertSshBrowserResourcesAbsent(f.targetId)).not.toThrow()
  } else {
    expect(() => assertSshBrowserResourcesAbsent(f.targetId)).toThrow()
  }
})
