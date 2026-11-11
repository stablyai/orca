import { describe, expect, it } from 'vitest'
import { LocalCommandBroker } from './local-command-broker'

function setup() {
  let clock = 1_000_000
  let seq = 0
  const timers: { at: number; run: () => void; cancelled: boolean }[] = []
  const broker = new LocalCommandBroker(
    () => clock,
    () => `lc_test${String(++seq).padStart(12, '0')}`,
    (run, ms) => {
      const timer = { at: clock + ms, run, cancelled: false }
      timers.push(timer)
      return { cancel: () => (timer.cancelled = true) }
    }
  )
  const advance = (ms: number): void => {
    clock += ms
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) {
        continue
      }
      if (timer.at <= clock) {
        timer.run()
      } else {
        timers.push(timer)
      }
    }
  }
  return { broker, advance }
}

const input = { command: 'xcrun simctl list', cwd: null, reason: null, agent: null }

describe('LocalCommandBroker', () => {
  it('refuses a request when no desktop is attached', () => {
    const { broker } = setup()
    expect(() => broker.request(input)).toThrow('local_commands_no_desktop')
  })

  it('lets only the desktop that started a command report its result', () => {
    const { broker } = setup()
    broker.attach('a1', 'device-a', () => {})
    broker.attach('b1', 'device-b', () => {})
    const { requestId } = broker.request(input)
    expect(broker.settle('device-a', { requestId, outcome: 'started' }).accepted).toBe(true)
    expect(broker.settle('device-b', { requestId, outcome: 'started' }).accepted).toBe(false)
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 5,
      stdout: 'ok',
      stderr: '',
      truncated: false
    }
    expect(broker.settle('device-b', { requestId, outcome: 'finished', result }).accepted).toBe(
      false
    )
    expect(broker.settle('device-a', { requestId, outcome: 'finished', result }).accepted).toBe(
      true
    )
    expect(broker.status(requestId)).toMatchObject({ status: 'finished', result: { stdout: 'ok' } })
  })

  it('rejects reports from a device that is not attached', () => {
    const { broker } = setup()
    broker.attach('a1', 'device-a', () => {})
    const { requestId } = broker.request(input)
    expect(() => broker.settle('device-x', { requestId, outcome: 'started' })).toThrow(
      'local_command_forbidden'
    )
  })

  it("keeps waiting for a person when another computer can't take the request", () => {
    const { broker } = setup()
    broker.attach('a1', 'device-a', () => {})
    broker.attach('b1', 'device-b', () => {})
    const { requestId } = broker.request(input)
    broker.settle('device-b', { requestId, outcome: 'declined', reason: 'not_allowed' })
    expect(broker.status(requestId).status).toBe('pending')
    broker.settle('device-a', { requestId, outcome: 'declined', reason: 'approval_timed_out' })
    expect(broker.status(requestId)).toMatchObject({
      status: 'declined',
      declineReason: 'not_allowed'
    })
  })

  it('settles at once when a person denies', () => {
    const { broker } = setup()
    broker.attach('a1', 'device-a', () => {})
    broker.attach('b1', 'device-b', () => {})
    const { requestId } = broker.request(input)
    broker.settle('device-a', { requestId, outcome: 'declined', reason: 'denied' })
    expect(broker.status(requestId)).toMatchObject({ status: 'declined', declineReason: 'denied' })
  })

  it('expires an unanswered request and loses a started one that never reports', () => {
    const { broker, advance } = setup()
    broker.attach('a1', 'device-a', () => {})
    const first = broker.request(input).requestId
    advance(5 * 60_000)
    expect(broker.status(first).status).toBe('expired')
    const second = broker.request({ ...input, timeoutSec: 10 }).requestId
    broker.settle('device-a', { requestId: second, outcome: 'started' })
    advance(10_000 + 30_000)
    expect(broker.status(second).status).toBe('lost')
  })

  it('replays a waiting request to a desktop that attaches later', () => {
    const { broker } = setup()
    broker.attach('a1', 'device-a', () => {})
    const { requestId } = broker.request(input)
    const seen: unknown[] = []
    broker.attach('a2', 'device-a', (event) => seen.push(event))
    expect(seen).toEqual([
      { type: 'ready' },
      expect.objectContaining({ type: 'requested', requestId, command: 'xcrun simctl list' })
    ])
  })
})
