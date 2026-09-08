import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

type Context = { ui: { setTitle: (title: string) => void }; isIdle?: () => boolean }
type Handler = (event: Record<string, unknown>, ctx: Context) => Promise<void>

function fixture(cwd = '/fixture/folder') {
  let next = 0
  const intervals = new Map<number, () => void>()
  const timeouts = new Map<number, () => void>()
  const titles: string[] = []
  const sandbox = {
    process: { env: { ORCA_PANE_KEY: 'fixture' }, cwd: () => cwd },
    setInterval: (cb: () => void) => {
      intervals.set(++next, cb)
      return next
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (cb: () => void) => {
      const id = ++next
      timeouts.set(id, () => {
        timeouts.delete(id)
        cb()
      })
      return id
    },
    clearTimeout: (id: number) => timeouts.delete(id),
    install: undefined as unknown as (pi: unknown) => void
  }
  runInNewContext(
    getPiTitlebarExtensionSource().replace(
      'export default function',
      'globalThis.install = function'
    ),
    sandbox
  )
  function registration() {
    let invalid: 'getter' | 'setter' | 'idle' | undefined
    let idle = false
    let apiCalls = 0
    const handlers: Record<string, Handler> = {}
    sandbox.install({
      on: (name: string, handler: Handler) => {
        handlers[name] = handler
      },
      getSessionName: () => {
        apiCalls++
        if (invalid === 'getter') {
          throw new Error('invalid')
        }
        return 'same-session'
      }
    })
    const context = (): Context => ({
      ui: {
        setTitle: (title) => {
          apiCalls++
          if (invalid === 'setter') {
            throw new Error('invalid')
          }
          titles.push(title)
        }
      },
      isIdle: () => {
        apiCalls++
        if (invalid === 'idle') {
          throw new Error('invalid')
        }
        return idle
      }
    })
    return {
      call: (name: string, event = {}) => handlers[name](event, context()),
      invalidate: (kind: typeof invalid) => {
        invalid = kind
      },
      setIdle: () => {
        idle = true
      },
      calls: () => apiCalls
    }
  }
  return { registration, intervals, timeouts, titles }
}

function first(callbacks: Map<number, () => void>): () => void {
  const callback = callbacks.values().next().value
  if (!callback) {
    throw new Error('expected scheduled callback')
  }
  return callback
}

describe('generated titlebar registration lifetime', () => {
  it.each(['getter', 'setter'] as const)(
    'retires on %s invalidation without escaping or restarting',
    async (kind) => {
      const h = fixture(),
        old = h.registration()
      await old.call('agent_start')
      const tick = first(h.intervals)
      old.invalidate(kind)
      expect(tick).not.toThrow()
      expect(h.intervals.size).toBe(0)
      const calls = old.calls()
      tick()
      await old.call('agent_start')
      await old.call('session_start')
      await old.call('agent_settled')
      expect(old.calls()).toBe(calls)
      expect(h.intervals.size).toBe(0)
    }
  )

  it.each(['getter', 'setter'] as const)(
    'does not schedule after immediate %s failure',
    async (kind) => {
      const h = fixture(),
        old = h.registration()
      old.invalidate(kind)
      await old.call('agent_start')
      expect(h.intervals.size).toBe(0)
    }
  )

  it('retires interval and pending work when the idle probe expires', async () => {
    const h = fixture(),
      old = h.registration()
    await old.call('agent_start')
    await old.call('agent_end')
    old.invalidate('idle')
    const poll = first(h.timeouts)
    poll()
    expect(h.intervals.size).toBe(0)
    expect(h.timeouts.size).toBe(0)
    const calls = old.calls()
    poll()
    expect(old.calls()).toBe(calls)
  })

  it.each(['agent', 'pending', 'maintenance'])(
    'recreates after %s shutdown with the same session name and a fresh API',
    async (state) => {
      const h = fixture(),
        old = h.registration()
      await old.call(state === 'maintenance' ? 'auto_compaction_start' : 'agent_start', {
        reason: 'idle'
      })
      if (state === 'pending') {
        await old.call('agent_end')
      }
      const tick = first(h.intervals)
      const poll = h.timeouts.size ? first(h.timeouts) : undefined
      old.invalidate('getter')
      const calls = old.calls()
      await old.call('session_shutdown')
      expect(old.calls()).toBe(calls)
      expect(h.intervals.size + h.timeouts.size).toBe(0)
      const fresh = h.registration()
      await fresh.call('session_start')
      expect(h.titles.at(-1)).toBe('π - same-session - folder')
      await fresh.call('agent_start')
      const count = h.titles.length
      tick()
      poll?.()
      await old.call('session_shutdown')
      await old.call('auto_compaction_end')
      await old.call('agent_settled')
      expect(h.titles).toHaveLength(count)
      expect(h.intervals.size).toBe(1)
      first(h.intervals)()
      expect(h.titles).toHaveLength(count + 1)
    }
  )

  it('rejects delayed legacy agent_end after shutdown while a fresh registration can poll', async () => {
    const h = fixture(),
      old = h.registration()
    await old.call('session_shutdown')
    const calls = old.calls()
    await old.call('agent_end')
    for (let i = 0; i < 3 && h.timeouts.size; i++) {
      first(h.timeouts)()
    }
    expect(old.calls()).toBe(calls)
    expect(h.timeouts.size).toBe(0)
    expect(h.intervals.size).toBe(0)

    const fresh = h.registration()
    await fresh.call('agent_end')
    expect(h.timeouts.size).toBe(1)
    for (let i = 0; i < 3; i++) {
      first(h.timeouts)()
    }
    expect(fresh.calls()).toBe(3)
    expect(h.timeouts.size).toBe(1)
    fresh.setIdle()
    first(h.timeouts)()
    expect(h.titles.at(-1)).toBe('π - same-session - folder')
    expect(h.timeouts.size).toBe(0)
    expect(h.intervals.size).toBe(0)
    expect(old.calls()).toBe(calls)
  })

  it('fences a queued frame and idle check when a new activity starts', async () => {
    const h = fixture(),
      live = h.registration()
    await live.call('agent_start')
    await live.call('agent_end')
    const tick = first(h.intervals),
      poll = first(h.timeouts)
    await live.call('agent_start')
    live.setIdle()
    const count = h.titles.length
    tick()
    poll()
    expect(h.titles).toHaveLength(count)
    expect(h.intervals.size).toBe(1)
    expect(h.timeouts.size).toBe(0)
  })

  it('fences a replaced idle check within the same activity', async () => {
    const h = fixture(),
      live = h.registration()
    await live.call('agent_start')
    await live.call('agent_end')
    const poll = first(h.timeouts)
    await live.call('agent_end', { willContinue: true })
    live.setIdle()
    poll()
    expect(h.intervals.size).toBe(1)
    expect(h.timeouts.size).toBe(0)
  })

  it.each(['getter', 'setter'] as const)(
    'retires safely when %s expires during settlement',
    async (kind) => {
      const h = fixture(),
        live = h.registration()
      await live.call('agent_start')
      live.invalidate(kind)
      await live.call('agent_settled')
      expect(h.intervals.size + h.timeouts.size).toBe(0)
      await live.call('agent_start')
      expect(h.intervals.size).toBe(0)
    }
  )

  it('keeps a fresh registration alive when an old API expires without shutdown', async () => {
    const h = fixture(),
      old = h.registration()
    await old.call('agent_start')
    const tick = first(h.intervals)
    const fresh = h.registration()
    await fresh.call('agent_start')
    old.invalidate('getter')
    tick()
    expect(h.intervals.size).toBe(1)
    const count = h.titles.length
    first(h.intervals)()
    expect(h.titles).toHaveLength(count + 1)
  })

  it.each(['/fixture/folder', 'C:\\fixture\\folder'])(
    'renders folder workspace path %s without git',
    async (cwd) => {
      const h = fixture(cwd),
        live = h.registration()
      await live.call('agent_start')
      expect(h.titles.at(-1)).toContain('π - same-session - folder')
    }
  )
})
