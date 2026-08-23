import { describe, expect, it } from 'vitest'
import { getAgentReadinessFailure } from './orchestration-agent-readiness'

describe('orchestration agent readiness', () => {
  it('accepts only live readiness', () => {
    expect(
      getAgentReadinessFailure({
        handle: 'term-worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      })
    ).toBeNull()
  })

  it('preserves known exit codes and does not invent an unknown one', () => {
    const failure = (exitCode: number | null) =>
      getAgentReadinessFailure({
        handle: 'term-worker',
        condition: 'tui-idle',
        satisfied: false,
        status: 'exited',
        exitCode
      })

    expect(failure(17)).toBe('Agent process exited before becoming ready with code 17.')
    expect(failure(null)).toBe('Agent process exited before becoming ready.')
  })

  it('includes only bounded redacted diagnostic output', () => {
    const dispatchCapability = `dcap_${'a'.repeat(32)}`
    const lines = [
      'old output that must be omitted',
      ...Array.from({ length: 20 }, (_, index) => `startup detail ${index}`),
      `Authorization: Bearer bearer-secret ${dispatchCapability} ${'x'.repeat(5_000)}`
    ]
    const failure = getAgentReadinessFailure(
      {
        handle: 'term-worker',
        condition: 'tui-idle',
        satisfied: false,
        status: 'exited',
        exitCode: 1
      },
      lines
    )!
    const diagnostic = failure.split('Diagnostic output:\n')[1]!

    expect(diagnostic.length).toBeLessThanOrEqual(4_000)
    expect(diagnostic).toContain('diagnostic output truncated')
    expect(diagnostic).not.toContain('old output that must be omitted')
    expect(diagnostic).not.toContain('bearer-secret')
    expect(diagnostic).not.toContain(dispatchCapability)
  })

  it('redacts multiline PEM blocks from diagnostic output', () => {
    const failure = getAgentReadinessFailure(
      {
        handle: 'term-worker',
        condition: 'tui-idle',
        satisfied: false,
        status: 'exited',
        exitCode: 1
      },
      [
        'startup failed while loading key',
        '-----BEGIN PRIVATE KEY-----',
        'multiline-secret-material',
        '-----END PRIVATE KEY-----'
      ]
    )!

    expect(failure).toContain('[redacted:pem]')
    expect(failure).not.toContain('multiline-secret-material')
  })
})
