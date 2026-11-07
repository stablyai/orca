import { expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from './generated-agent-input-notices'
import {
  forwardGeneratedInputNotices,
  type GeneratedInputNoticeHosts
} from './generated-agent-input-notice-forwarder'

type Call = {
  host: string
  id: string
  method: string
  index?: number
  release: (reached: boolean) => void
}

/** Paired hosts whose calls answer only when released; every attempt is recorded. */
function hosts() {
  const calls: Call[] = []
  let status: (environmentId?: string) => void = () => {}
  const hostsApi: GeneratedInputNoticeHosts = {
    call: (host, method, params) =>
      new Promise((resolve, reject) => {
        const part = (params as { part?: { index: number } }).part
        calls.push({
          host: host.environmentId,
          id: (params as { id: string }).id,
          method,
          ...(part ? { index: part.index } : {}),
          release: (reached) =>
            reached
              ? resolve({
                  id: method,
                  ok: true,
                  result: {
                    retained: true,
                    dismissed: true,
                    part:
                      part && !(params as { part: { final: boolean } }).part.final
                        ? 'accepted'
                        : undefined
                  },
                  _meta: { runtimeId: 'h' }
                })
              : reject(new Error('socket closed'))
        })
      }),
    onStatusChanged: (listener) => {
      status = listener
      return () => {}
    },
    onEnvironmentRetired: () => () => {},
    isManuallyDisconnected: () => false
  }
  return { calls, hostsApi, status: (environmentId?: string) => status(environmentId) }
}

function owe(
  notices: GeneratedAgentInputNotices,
  id: string,
  environmentId: string,
  text = 'exact'
) {
  notices.upsert({
    id,
    text,
    agent: 'claude',
    certainty: 'unconfirmed',
    handle: 'terminal',
    ptyId: null,
    worktreeId: '',
    origin: 'window',
    owner: { environmentId, runtimeId: `${environmentId}-runtime`, pairingRevision: 1, window: 'w' }
  })
}

const settled = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve()
  }
}

// P10: a host with N parked commands is attempted one command at a time; reading its owed work
// costs what is attempted, not the whole parked suffix.
it.each([100, 1_000])(
  'reads only the attempted command across %i parked admissions',
  async (count) => {
    const notices = new GeneratedAgentInputNotices()
    const { calls, hostsApi } = hosts()
    // Count the actual enumeration map, including work before the first attempted call.
    const current = (notices.commands as unknown as { current: Map<string, unknown> }).current
    const reads = vi.spyOn(current, 'get')
    const owed = notices.commands.owedTo.bind(notices.commands)
    let yielded = 0
    vi.spyOn(notices.commands, 'owedTo').mockImplementation(function* (environmentId) {
      for (const command of owed(environmentId)) {
        yielded++
        yield command
      }
    })
    const stop = forwardGeneratedInputNotices(notices, hostsApi)
    try {
      for (let index = 0; index < count; index += 1) {
        notices.dismiss(`op-${index}`, 'window', {
          environmentId: 'env',
          runtimeId: 'env-runtime',
          pairingRevision: 1,
          window: 'w'
        })
        expect(calls).toHaveLength(index + 1)
        calls[index].release(false)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      // Each arrival attempts one command; the unreachable suffix remains owed, without a replay.
      expect(yielded).toBe(count)
      expect(reads.mock.calls.length).toBeLessThanOrEqual(count * 6)
      expect(current.size).toBe(count)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(calls).toHaveLength(count)
    } finally {
      stop()
    }
  }
)

// P11/XR4: a status change of one host wakes only that host's owed work.
it.each([10, 100])('wakes only the named host among %i owed hosts', async (count) => {
  const notices = new GeneratedAgentInputNotices()
  const { calls, hostsApi, status } = hosts()
  forwardGeneratedInputNotices(notices, hostsApi)
  for (let index = 0; index < count; index += 1) {
    owe(notices, `op-${index}`, `env-${index}`)
  }
  await vi.waitFor(() => expect(calls).toHaveLength(count))
  for (const call of calls.splice(0)) {
    call.release(false)
  }
  await settled()
  status('env-3')
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  await settled()
  expect(calls.map(({ host }) => host)).toEqual(['env-3'])
})

// P12/CR7: a copy superseded by a Dismiss, or a stopped forwarder, sends no later upload part,
// and the successor discard still goes; a late answer never completes the newer command.
it('sends no later part of a superseded or stopped upload', async () => {
  const notices = new GeneratedAgentInputNotices()
  const { calls, hostsApi } = hosts()
  forwardGeneratedInputNotices(notices, hostsApi)
  owe(notices, 'op-large', 'env', 'x'.repeat(300_000))
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  expect(calls[0]).toMatchObject({ method: 'terminal.generatedInputNotices.register', index: 0 })
  notices.dismiss('op-large', 'window')
  calls[0].release(true)
  await vi.waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1].method).toBe('terminal.dismissGeneratedInputNotice')
  expect(notices.commands.of('op-large')?.kind).toBe('discard')
  calls[1].release(true)
  await vi.waitFor(() => expect(notices.commands.of('op-large')).toBeUndefined())

  const stopped = new GeneratedAgentInputNotices()
  const second = hosts()
  const stop = forwardGeneratedInputNotices(stopped, second.hostsApi)
  owe(stopped, 'op-stopped', 'env', 'x'.repeat(300_000))
  await vi.waitFor(() => expect(second.calls).toHaveLength(1))
  stop()
  second.calls[0].release(true)
  await settled()
  expect(second.calls).toHaveLength(1)
  // Left for a successor forwarder, not completed by the stopped one.
  expect(stopped.commands.of('op-stopped')?.kind).toBe('register')
})

// Cancellation after a consumed reconnect wake is progress; the next already-owed command must run.
it('drains a parked discard after the earlier multipart copy is cancelled without a new wake', async () => {
  const notices = new GeneratedAgentInputNotices()
  const remote = new GeneratedAgentInputNotices()
  remote.upsert({
    id: 'B',
    text: 'host copy',
    agent: 'claude',
    certainty: 'not-sent',
    handle: 't',
    worktreeId: '',
    ptyId: null,
    origin: 'window'
  })
  const { calls, hostsApi, status } = hosts()
  const call = hostsApi.call
  hostsApi.call = (host, method, params, options) => {
    if (method === 'terminal.dismissGeneratedInputNotice') {
      remote.dismiss((params as { id: string }).id, 'window')
    }
    return call(host, method, params, options)
  }
  const stop = forwardGeneratedInputNotices(notices, hostsApi)
  try {
    owe(notices, 'A', 'env', 'x'.repeat(300_000))
    expect(calls).toHaveLength(1)
    calls[0].release(false)
    await settled()
    notices.dismiss('B', 'window', {
      environmentId: 'env',
      runtimeId: 'env-runtime',
      pairingRevision: 1,
      window: 'w'
    })
    expect(calls).toHaveLength(2)
    calls[1].release(false)
    await settled()
    expect(remote.noticeOf('B')).toBeDefined()
    status('env')
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({ id: 'A', index: 0 })
    notices.hostAnswered('A', 'window', { kind: 'retained', runtimeId: 'env-runtime' })
    calls[2].release(true)
    await settled()
    expect(calls).toHaveLength(4)
    expect(calls[3]).toMatchObject({ id: 'B', method: 'terminal.dismissGeneratedInputNotice' })
    expect(remote.noticeOf('B')).toBeUndefined()
    expect(notices.commands.of('B')?.kind).toBe('discard')
    expect(notices.commands.withheldPage('window', 0, 10_000).ids).toEqual(['B'])
    calls[3].release(true)
    await settled()
    expect(notices.commands.of('B')).toBeUndefined()
    expect(notices.commands.withheldPage('window', 0, 10_000).ids).toEqual([])
    expect(calls.filter((entry) => entry.id === 'A').map((entry) => entry.index)).toEqual([0, 0, 0])
    await settled()
    expect(calls).toHaveLength(4)
  } finally {
    stop()
  }
})
