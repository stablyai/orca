import { describe, expect, it } from 'vitest'
import { GLOBAL_FLAGS, effectiveAllowedFlags } from '../args'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

function spec(path: string): (typeof ORCHESTRATION_COMMAND_SPECS)[number] {
  const found = ORCHESTRATION_COMMAND_SPECS.find((entry) => entry.path.join(' ') === path)
  if (!found) {
    throw new Error(`Missing orchestration spec: ${path}`)
  }
  return found
}

describe('orchestration collaboration command specs', () => {
  it('defines collaboration-publish with topic flags and no identity flags', () => {
    const publish = spec('orchestration collaboration-publish')
    expect(effectiveAllowedFlags(publish)).toEqual([
      ...new Set([
        ...GLOBAL_FLAGS,
        'topic',
        'semantic-type',
        'priority',
        'body',
        'from',
        'dispatch-capability',
        'retry-request'
      ])
    ])
    expect(publish.allowedFlags).not.toContain('task-id')
    expect(publish.allowedFlags).not.toContain('dispatch-id')
    expect(publish.allowedFlags).not.toContain('subscriber')
    expect(publish.allowedFlags).not.toContain('publication-id')
  })

  it('defines collaboration-checkpoint with wait flags and no identity flags', () => {
    const checkpoint = spec('orchestration collaboration-checkpoint')
    expect(effectiveAllowedFlags(checkpoint)).toEqual([
      ...new Set([
        ...GLOBAL_FLAGS,
        'from',
        'limit',
        'wait',
        'timeout-ms',
        'dispatch-capability',
        'retry-request'
      ])
    ])
    expect(checkpoint.allowedFlags).not.toContain('task-id')
    expect(checkpoint.allowedFlags).not.toContain('dispatch-id')
    expect(checkpoint.allowedFlags).not.toContain('subscriber')
    expect(checkpoint.allowedFlags).not.toContain('publication-id')
  })

  it('defines collaboration-configure with run/steps and no identity flags', () => {
    const configure = spec('orchestration collaboration-configure')
    expect(effectiveAllowedFlags(configure)).toEqual([
      ...new Set([...GLOBAL_FLAGS, 'run', 'from', 'steps', 'retry-request'])
    ])
    expect(configure.allowedFlags).not.toContain('task-id')
    expect(configure.allowedFlags).not.toContain('dispatch-id')
    expect(configure.allowedFlags).not.toContain('subscriber')
    expect(configure.allowedFlags).not.toContain('publication-id')
  })

  it('defines collaboration-ack with message-ids and no identity flags', () => {
    const ack = spec('orchestration collaboration-ack')
    expect(effectiveAllowedFlags(ack)).toEqual([
      ...new Set([...GLOBAL_FLAGS, 'from', 'message-ids', 'dispatch-capability', 'retry-request'])
    ])
    expect(ack.allowedFlags).not.toContain('task-id')
    expect(ack.allowedFlags).not.toContain('dispatch-id')
    expect(ack.allowedFlags).not.toContain('subscriber')
    expect(ack.allowedFlags).not.toContain('publication-id')
  })
})
