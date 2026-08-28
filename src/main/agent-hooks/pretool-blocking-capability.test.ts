import { describe, expect, it } from 'vitest'
import {
  canBlockBeforeMutation,
  pretoolBlockingCapability,
  toolCanMutate
} from './pretool-blocking-capability'

/** Capability is a property of the (agent, installed transport) pair.
 *
 *  Orca's POSIX Claude hook captures the endpoint's reply and exits 2 on a deny.
 *  The local Windows .cmd for the SAME agent posts fire-and-forget and exits 0,
 *  so nothing there can stop a tool call — and reporting `claude` as blocking
 *  everywhere admitted a Windows route as fenced when it was not. */
describe('which installed routes can actually stop a tool call', () => {
  it('NEGATIVE CONTROL: local Windows Claude cannot certify mutation fencing', () => {
    expect(canBlockBeforeMutation('claude', 'win32')).toBe(false)
    const capability = pretoolBlockingCapability('claude', 'win32')
    expect(capability.kind).toBe('unsupported')
    expect(capability.kind === 'unsupported' && capability.reason).toMatch(
      /posts the event and exits 0 without reading the reply/
    )
    // And it names what to do instead, rather than just refusing.
    expect(capability.kind === 'unsupported' && capability.reason).toMatch(/isolated worktree/)
  })

  it('preserves POSIX Claude blocking', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      expect(canBlockBeforeMutation('claude', platform)).toBe(true)
      const capability = pretoolBlockingCapability('claude', platform)
      expect(capability.kind).toBe('blocking')
      expect(capability.kind === 'blocking' && capability.denyBody('because')).toContain(
        '"permissionDecision":"deny"'
      )
    }
  })

  it('every other route stays unsupported on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      for (const source of ['codex', 'gemini', 'grok', 'copilot', 'cursor'] as const) {
        expect(canBlockBeforeMutation(source, platform)).toBe(false)
      }
    }
  })

  it('treats Task and every unknown tool as mutating', () => {
    // Task reads like a planning verb but spawns a subagent that runs Bash and
    // Edit of its own.
    expect(toolCanMutate('Task')).toBe(true)
    expect(toolCanMutate('SomeToolOrcaHasNeverSeen')).toBe(true)
    expect(toolCanMutate(undefined)).toBe(true)
    expect(toolCanMutate('Read')).toBe(false)
    expect(toolCanMutate('Grep')).toBe(false)
  })
})
