import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOpenCode2SetupSource } from './status-plugin-setup-source'

type Hooks = { event: (event: unknown) => Promise<void>; dispose?: () => Promise<void> }

function createSetup(factory: () => Promise<Hooks>) {
  const setup: unknown = new Function(
    'OrcaOpenCodeStatusPlugin',
    'AbortController',
    'console',
    `${getOpenCode2SetupSource().join('\n')}\nreturn setupOpenCode2Status;`
  )(factory, AbortController, { warn: vi.fn() })
  if (typeof setup !== 'function') {
    throw new Error('Missing generated setup')
  }
  return async (context: unknown) => {
    const cleanup: unknown = await setup(context)
    if (typeof cleanup !== 'function') {
      throw new Error('Missing generated cleanup')
    }
    return cleanup
  }
}

function deferred() {
  let finish = () => {}
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 }))
  )
})
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

describe('generated OpenCode 2 setup ownership', () => {
  it.each(['throw', 'reject'] as const)(
    'disposes the factory after prompt registration %s',
    async (failure) => {
      const hooks = { event: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
      const subscribe = vi.fn(async function* () {})
      const hook = () => {
        if (failure === 'throw') {
          throw new Error('Registration failed')
        }
        return Promise.reject(new Error('Registration failed'))
      }
      const cleanup = await createSetup(async () => hooks)({
        session: { hook },
        event: { subscribe }
      })
      expect(hooks.dispose).toHaveBeenCalledOnce()
      expect(subscribe).not.toHaveBeenCalled()
      await cleanup()
      expect(hooks.dispose).toHaveBeenCalledOnce()
    }
  )

  it.each(['throw', 'reject'] as const)(
    'disposes the factory after prompt cleanup %s',
    async (failure) => {
      const hooks = { event: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
      const promptDispose = vi.fn(() => {
        if (failure === 'throw') {
          throw new Error('Prompt cleanup failed')
        }
        return Promise.reject(new Error('Prompt cleanup failed'))
      })
      let signal: AbortSignal | undefined
      const cleanup = await createSetup(async () => hooks)({
        session: { hook: async () => ({ dispose: promptDispose }) },
        event: {
          subscribe: (options: { signal: AbortSignal }) => {
            signal = options.signal
            return []
          }
        }
      })
      await cleanup()
      expect(signal?.aborted).toBe(true)
      expect(promptDispose).toHaveBeenCalledOnce()
      expect(hooks.dispose).toHaveBeenCalledOnce()
    }
  )

  it('waits for in-flight delivery before factory cleanup after a prompt cleanup failure', async () => {
    const delivery = deferred()
    const started = deferred()
    const order: string[] = []
    const hooks = {
      event: vi.fn(async () => {
        started.finish()
        await delivery.promise
        order.push('event')
      }),
      dispose: vi.fn(async () => {
        order.push('factory')
      })
    }
    const cleanup = await createSetup(async () => hooks)({
      session: {
        hook: async () => ({
          dispose: async () => {
            order.push('prompt')
            throw new Error('Failed')
          }
        })
      },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          try {
            yield { type: 'session.execution.started', data: { sessionID: 'synthetic' } }
            if (!signal.aborted) {
              yield { type: 'session.execution.succeeded', data: { sessionID: 'synthetic' } }
            }
          } finally {
            order.push('subscription')
          }
        }
      }
    })
    await started.promise
    const disposing = cleanup()
    await Promise.resolve()
    expect(hooks.dispose).not.toHaveBeenCalled()
    delivery.finish()
    await disposing
    expect(order).toEqual(['prompt', 'event', 'subscription', 'factory'])
    expect(hooks.event).toHaveBeenCalledOnce()
    expect(hooks.dispose).toHaveBeenCalledOnce()
  })

  it.each(['setup', 'unload'] as const)(
    'keeps %s fail-open when factory cleanup also rejects',
    async (stage) => {
      const hooks = {
        event: vi.fn(async () => {}),
        dispose: vi.fn(async () => {
          throw new Error('Factory cleanup failed')
        })
      }
      const cleanup = await createSetup(async () => hooks)({
        session: {
          hook: async () => {
            if (stage === 'setup') {
              throw new Error('Registration failed')
            }
            return {
              dispose: async () => {
                throw new Error('Prompt cleanup failed')
              }
            }
          }
        },
        event: { subscribe: async function* () {} }
      })
      await cleanup()
      expect(hooks.dispose).toHaveBeenCalledOnce()
    }
  )

  it('disposes both owners once on ordinary unload', async () => {
    const hooks = { event: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
    const promptDispose = vi.fn(async () => {})
    const cleanup = await createSetup(async () => hooks)({
      session: { hook: async () => ({ dispose: promptDispose }) },
      event: { subscribe: async function* () {} }
    })
    expect(hooks.dispose).not.toHaveBeenCalled()
    await cleanup()
    expect(promptDispose).toHaveBeenCalledOnce()
    expect(hooks.dispose).toHaveBeenCalledOnce()
  })

  it('accepts absent optional disposers', async () => {
    const cleanup = await createSetup(async () => ({ event: async () => {} }))({
      session: { hook: async () => undefined },
      event: { subscribe: async function* () {} }
    })
    await cleanup()
  })

  it('skips allocation for an unusable context and tolerates factory rejection', async () => {
    const factory = vi.fn(async (): Promise<Hooks> => {
      throw new Error('Factory failed')
    })
    await (
      await createSetup(factory)(undefined)
    )()
    expect(factory).not.toHaveBeenCalled()
    await (
      await createSetup(factory)({ session: { hook: vi.fn() }, event: { subscribe: vi.fn() } })
    )()
    expect(factory).toHaveBeenCalledOnce()
  })
})
