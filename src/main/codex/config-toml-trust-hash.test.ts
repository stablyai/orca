import { describe, expect, it } from 'vitest'
import { computeTrustedHash, type CodexTrustEntry } from './config-toml-trust'

// Why: captured from a real Codex 0.129 `/hooks` approval; fails loudly if Codex's serialization drifts.
const REAL_APPROVED_COMMAND = '/bin/sh "/tmp/orca-case-b-mCmCe6/agent-hooks/codex-hook.sh"'
const REAL_APPROVED_HASH = 'sha256:bc013489dba495431d3790fda62ee5a7d907a7c491e29ad26238c3a5d6d2b163'

describe('computeTrustedHash', () => {
  it('reproduces the hash that Codex /hooks wrote for a real approval', () => {
    expect(
      computeTrustedHash({
        sourcePath: '/Users/thebr/.codex/hooks.json',
        eventLabel: 'pre_tool_use',
        groupIndex: 0,
        handlerIndex: 0,
        command: REAL_APPROVED_COMMAND
      })
    ).toBe(REAL_APPROVED_HASH)
  })

  it('produces a different hash when the command changes', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'bar'
    })
    expect(a).not.toBe(b)
  })

  it('produces a different hash when the event label changes', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'post_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    expect(a).not.toBe(b)
  })

  it('ignores groupIndex/handlerIndex (those are part of the key, not the hash)', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 99,
      handlerIndex: 99,
      command: 'foo'
    })
    expect(a).toBe(b)
  })

  it('hashes a missing matcher the same as no matcher field', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      matcher: undefined
    })
    expect(a).toBe(b)
  })

  it('produces a different hash when matcher is set', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      matcher: 'foo'
    })
    expect(a).not.toBe(b)
  })

  it('drops the matcher on user_prompt_submit/stop like matcher_pattern_for_event', () => {
    // Why: Codex hashes these two events WITHOUT the matcher, so `"matcher": ""` must hash like no matcher.
    for (const eventLabel of ['user_prompt_submit', 'stop'] as const) {
      const base: CodexTrustEntry = {
        sourcePath: '/x/hooks.json',
        eventLabel,
        groupIndex: 0,
        handlerIndex: 0,
        command: 'foo'
      }
      const bare = computeTrustedHash(base)
      expect(computeTrustedHash({ ...base, matcher: '' })).toBe(bare)
      expect(computeTrustedHash({ ...base, matcher: 'anything' })).toBe(bare)
    }
  })

  it('pins the matcher-omitted hash for a Stop entry that carries an empty matcher', () => {
    // Why: regression pin (real Codex 0.140 config) — Stop uses the matcher-omitted hash even with `"matcher": ""`.
    expect(
      computeTrustedHash({
        sourcePath: '/home/user/.codex/hooks.json',
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: '/home/user/.tma1/hooks/agent-hook.sh',
        matcher: ''
      })
    ).toBe('sha256:f8b48c31eabfba63f117b8570b839a5f6efc1d67867512d661775b5312df946f')
  })

  it('produces a different hash when statusMessage is set', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      statusMessage: 'msg'
    })
    expect(a).not.toBe(b)
  })

  it('produces a different hash when async flips from default false to true', () => {
    const a = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      async: false
    })
    const b = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      async: true
    })
    expect(a).not.toBe(b)
  })

  it('clamps timeoutSec=0 to 1 (which differs from the unset default of 600)', () => {
    const zero = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      timeoutSec: 0
    })
    const one = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo',
      timeoutSec: 1
    })
    const unset = computeTrustedHash({
      sourcePath: '/x/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'foo'
    })
    expect(zero).toBe(one)
    expect(zero).not.toBe(unset)
  })
})
