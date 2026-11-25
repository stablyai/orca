import { describe, expect, it } from 'vitest'
import { createClaudeFullAccessPolicy } from './claude-full-access-policy'

const status = (mode: string): string =>
  `${JSON.stringify({ type: 'system', subtype: 'status', session_id: 's1', permissionMode: mode })}\n`
const request = (id: string): string =>
  `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool' } })}\n`

const EVENTS = ['pick-ask', 'pick-full', 'report-ask', 'report-full', 'request'] as const
type Event = (typeof EVENTS)[number]

function* interleavings(length: number): Generator<Event[]> {
  if (length === 0) {
    yield []
    return
  }
  for (const rest of interleavings(length - 1)) {
    for (const event of EVENTS) {
      yield [...rest, event]
    }
  }
}

describe('live Full access policy', () => {
  it('auto-approves only where the latest pick is Full access and Claude confirmed it, in any interleaving', () => {
    for (const live of [false, true]) {
      for (const events of interleavings(6)) {
        const policy = createClaudeFullAccessPolicy('s1', live)
        // A Full access launch is that pick, and its process runs Full access until it reports;
        // a live policy starts at a kept agent's pick, before which Claude's mode is unknown.
        let pickedFull = !live
        let claudeFull = !live
        const stamped = new Map<string, boolean>()
        events.forEach((event, index) => {
          if (event === 'pick-ask' || event === 'pick-full') {
            pickedFull = event === 'pick-full'
            policy.picked(pickedFull)
            if (!pickedFull) {
              stamped.forEach((_, id) => stamped.set(id, false))
            }
          } else if (event === 'request') {
            stamped.set(`r${index}`, pickedFull && claudeFull)
            policy.observe(request(`r${index}`))
          } else {
            claudeFull = event === 'report-full'
            policy.observe(status(claudeFull ? 'bypassPermissions' : 'default'))
          }
        })
        policy.observe(request('after'))
        stamped.set('after', pickedFull && claudeFull)
        for (const [id, allowed] of stamped) {
          expect(policy.allows(id), `${live ? 'live' : 'launch'} ${events.join(',')} ${id}`).toBe(
            pickedFull && allowed
          )
        }
      }
    }
  })

  it("reads a reattached agent's waiting request under the mode Claude last confirmed", () => {
    const kept = createClaudeFullAccessPolicy('s1')
    kept.reattached()
    kept.observe(request('unknown-mode'))
    kept.observe(status('default'))
    kept.observe(status('bypassPermissions'))
    kept.observe(request('confirmed-full-access'))
    expect(kept.allows('unknown-mode')).toBe(false)
    expect(kept.allows('confirmed-full-access')).toBe(true)
  })
})
