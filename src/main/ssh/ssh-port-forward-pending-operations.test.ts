import { describe, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import { SshPortForwardManager } from './ssh-port-forward'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

function createFixture() {
  const starts: {
    options: PortForwardStartOptions
    gate: ReturnType<typeof Promise.withResolvers<StartedPortForward>>
  }[] = []
  const closed: number[] = []
  const provider: SshPortForwardProvider = {
    canHandle: () => true,
    start: (_connection, options) => {
      const gate = Promise.withResolvers<StartedPortForward>()
      starts.push({ options, gate })
      return gate.promise
    }
  }
  const manager = new SshPortForwardManager({}, [provider])
  const connection = new SshConnection(
    { id: 'target', label: 'Fixture', host: 'localhost', port: 22, username: 'fixture' },
    { onStateChange: vi.fn() }
  )
  const settle = (
    index: number,
    closeGate?: ReturnType<typeof Promise.withResolvers<void>>
  ): StartedPortForward => {
    const start = starts[index]
    if (!start) {
      throw new Error(`Missing start ${index}`)
    }
    const { options } = start
    void closeGate?.promise.catch(() => {})
    const owner: StartedPortForward = {
      entry: {
        id: options.id,
        connectionId: options.connectionId,
        localPort: options.localPort,
        remoteHost: options.remoteHost,
        remotePort: options.remotePort,
        label: options.label
      },
      close: () => {
        closed.push(index)
        return closeGate?.promise ?? Promise.resolve()
      },
      dispose: vi.fn()
    }
    start.gate.resolve(owner)
    return owner
  }
  const add = (target = 'target', port = 3000) =>
    observe(manager.addForward(target, connection, port, 'localhost', 80))
  const activate = async (closeGate?: ReturnType<typeof Promise.withResolvers<void>>) => {
    const adding = add()
    const owner = settle(0, closeGate)
    expect((await adding).status).toBe('fulfilled')
    return owner.entry
  }
  return { manager, connection, starts, settle, add, activate, closed }
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  )
}

async function settleMicrotasks() {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

describe('pending SSH forward ownership', () => {
  it('waits for a late owner to close before removal completes', async () => {
    const f = createFixture()
    const adding = f.add()
    const close = Promise.withResolvers<void>()
    let removed = false
    const removal = f.manager.removeAllForwards('target').then(() => {
      removed = true
    })
    await settleMicrotasks()
    expect(removed).toBe(false)
    f.settle(0, close)
    await settleMicrotasks()
    expect(f.closed).toEqual([0])
    expect(removed).toBe(false)
    close.resolve()
    await removal
    expect((await adding).status).toBe('rejected')
    expect(f.manager.listForwards()).toEqual([])
  })

  it('disposes pending starts and still admits later operations', async () => {
    const f = createFixture()
    const first = f.add()
    f.manager.dispose()
    f.manager.dispose()
    f.settle(0)
    expect((await first).status).toBe('rejected')
    expect(f.closed).toEqual([0])
    const next = f.add()
    f.settle(1)
    expect((await next).status).toBe('fulfilled')
    expect(f.manager.listForwards()).toHaveLength(1)
    f.manager.dispose()
  })

  it.each(['all', 'one', 'dispose'] as const)(
    'fences the old-close gap during update with %s',
    async (method) => {
      const f = createFixture()
      const close = Promise.withResolvers<void>()
      const entry = await f.activate(close)
      const updating = observe(
        f.manager.updateForward(entry.id, f.connection, 3001, 'localhost', 81)
      )
      await settleMicrotasks()
      let removal: Promise<unknown> = Promise.resolve()
      if (method === 'all') {
        removal = f.manager.removeAllForwards('target')
      }
      if (method === 'one') {
        removal = f.manager.removeForwardAndWait(entry.id)
      }
      if (method === 'dispose') {
        f.manager.dispose()
      }
      close.resolve()
      await settleMicrotasks()
      if (f.starts[1]) {
        f.settle(1)
      }
      await removal
      expect((await updating).status).toBe('rejected')
      expect(f.starts).toHaveLength(1)
      expect(f.manager.listForwards()).toEqual([])
    }
  )

  it('does not restore a forward removed during replacement startup', async () => {
    const f = createFixture()
    const entry = await f.activate()
    const updating = observe(f.manager.updateForward(entry.id, f.connection, 3001, 'localhost', 81))
    await settleMicrotasks()
    const removal = f.manager.removeAllForwards('target')
    f.settle(1)
    await settleMicrotasks()
    if (f.starts[2]) {
      f.settle(2)
    }
    await removal
    expect((await updating).status).toBe('rejected')
    expect(f.starts).toHaveLength(2)
    expect(f.manager.listForwards()).toEqual([])
  })

  it('retires a rollback started before removal while preserving the original error', async () => {
    const f = createFixture()
    const entry = await f.activate()
    const updating = observe(f.manager.updateForward(entry.id, f.connection, 3001, 'localhost', 81))
    await settleMicrotasks()
    const error = new Error('new bind failed')
    f.starts[1]?.gate.reject(error)
    await settleMicrotasks()
    const removal = f.manager.removeAllForwards('target')
    f.settle(2)
    await removal
    expect(await updating).toEqual({ status: 'rejected', error })
    expect(f.manager.listForwards()).toEqual([])
    expect(f.closed).toEqual([0, 2])
  })

  it('preserves ordinary failed-update rollback identity and refusal', async () => {
    const f = createFixture()
    const entry = await f.activate()
    const updating = observe(f.manager.updateForward(entry.id, f.connection, 3001, 'localhost', 81))
    await settleMicrotasks()
    const error = new Error('new bind failed')
    f.starts[1]?.gate.reject(error)
    await settleMicrotasks()
    f.settle(2)
    expect(await updating).toEqual({ status: 'rejected', error })
    expect(f.manager.listForwards()).toEqual([entry])
    f.manager.dispose()
  })

  it('propagates late-close errors to both admission and awaited teardown', async () => {
    const f = createFixture()
    const adding = f.add()
    const close = Promise.withResolvers<void>()
    const removal = observe(f.manager.removeAllForwards('target'))
    f.settle(0, close)
    await settleMicrotasks()
    const error = new Error('late close failed')
    close.reject(error)
    expect(await adding).toEqual({ status: 'rejected', error })
    expect(await removal).toEqual({ status: 'rejected', error })
    expect(f.manager.listForwards()).toEqual([])
  })

  it('propagates old-close errors through an update canceled in its close gap', async () => {
    const f = createFixture()
    const close = Promise.withResolvers<void>()
    const entry = await f.activate(close)
    const updating = observe(f.manager.updateForward(entry.id, f.connection, 3001, 'localhost', 81))
    await settleMicrotasks()
    const removal = observe(f.manager.removeAllForwards('target'))
    const error = new Error('old close failed')
    close.reject(error)
    expect(await updating).toEqual({ status: 'rejected', error })
    expect(await removal).toEqual({ status: 'rejected', error })
    expect(f.starts).toHaveLength(1)
  })

  it('keeps provider-start refusal while canceled teardown finishes', async () => {
    const f = createFixture()
    const adding = f.add()
    const removal = f.manager.removeAllForwards('target')
    const error = new Error('bind: Address already in use')
    f.starts[0]?.gate.reject(error)
    await removal
    expect(await adding).toEqual({ status: 'rejected', error })
    expect(f.closed).toEqual([])
  })

  it('joins repeated removals once and leaves unrelated and newly admitted owners intact', async () => {
    const f = createFixture()
    const old = f.add()
    const other = f.add('other')
    const removals = [f.manager.removeAllForwards('target'), f.manager.removeAllForwards('target')]
    const current = f.add('target', 4000)
    f.settle(2)
    f.settle(1)
    f.settle(0)
    await Promise.all(removals)
    expect((await old).status).toBe('rejected')
    expect((await other).status).toBe('fulfilled')
    expect((await current).status).toBe('fulfilled')
    expect(f.closed).toEqual([0])
    expect(f.manager.listForwards().map((entry) => [entry.connectionId, entry.localPort])).toEqual([
      ['target', 4000],
      ['other', 3000]
    ])
    f.manager.dispose()
  })
})
