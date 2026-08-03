// Phase 4 mode-dependent empty output. The two modes produce fundamentally
// different artifacts, so a single empty-output rule would be wrong:
//  - plan is read-only; its ONLY product is the stdout text.
//  - direct writes files; its product is the worktree diff and stdout is
//    incidental commentary.
import { describe, expect, it } from 'vitest'
import { decideExecutionOutcome } from './audited-execution-outcome'
import { hasMeaningfulOutput } from './audited-execution-output-store'

function decide(args: {
  mode: 'plan' | 'direct'
  stdout: string
  exitCode?: number
  drift?: 'head_moved_from_base_commit' | null
}): ReturnType<typeof decideExecutionOutcome> {
  return decideExecutionOutcome({
    mode: args.mode,
    activeRunState: args.mode === 'plan' ? 'planning' : 'implementing',
    outcome: { kind: 'exit', exitCode: args.exitCode ?? 0, stdout: args.stdout, stderr: '' },
    driftReasonCode: args.drift ?? null,
    hasStdout: hasMeaningfulOutput(args.stdout)
  })
}

describe('plan mode requires non-empty stdout', () => {
  it.each(['', '   ', '\n\t\n'])('blocks on exit 0 with stdout %j', (stdout) => {
    const decision = decide({ mode: 'plan', stdout })
    expect(decision.status).toBe('failed')
    expect(decision.reasonCode).toBe('empty_output')
    expect(decision.toState).toBe('blocked')
    expect(decision.blockedReasonCode).toBe('plan_output_empty')
    expect(decision.preBlockState).toBe('planning')
  })

  it('advances to awaiting_plan_review when a plan was produced', () => {
    const decision = decide({ mode: 'plan', stdout: 'Here is the plan.' })
    expect(decision.status).toBe('succeeded')
    expect(decision.toState).toBe('awaiting_plan_review')
    expect(decision.reasonCode).toBeNull()
  })
})

describe('direct mode does not require stdout', () => {
  it('succeeds on exit 0 with blank stdout and a clean worktree', () => {
    const decision = decide({ mode: 'direct', stdout: '' })
    expect(decision.status).toBe('succeeded')
    expect(decision.toState).toBe('awaiting_code_audit')
    expect(decision.reasonCode).toBeNull()
  })

  it('blocks on drift even with blank stdout — drift beats a clean exit code', () => {
    const decision = decide({
      mode: 'direct',
      stdout: '',
      drift: 'head_moved_from_base_commit'
    })
    expect(decision.status).toBe('blocked')
    expect(decision.reasonCode).toBe('unexpected_commit_detected')
    expect(decision.toState).toBe('blocked')
    expect(decision.toState).not.toBe('awaiting_code_audit')
  })
})

describe('non-zero exits block in both modes', () => {
  it.each([
    ['plan', 'plan_process_failed'],
    ['direct', 'implement_process_failed']
  ] as const)('%s mode maps to %s', (mode, blockedReasonCode) => {
    const decision = decide({ mode, stdout: 'partial', exitCode: 2 })
    expect(decision.reasonCode).toBe('exit_nonzero')
    expect(decision.blockedReasonCode).toBe(blockedReasonCode)
  })
})

describe('process-level failures', () => {
  it.each([
    ['not_found', 'claude_not_found', 'claude_not_found'],
    ['spawn_failed', 'spawn_failed', 'implement_process_failed'],
    ['timeout', 'timeout', 'agent_timeout'],
    ['output_too_large', 'output_too_large', 'agent_output_too_large']
  ] as const)('%s maps to %s / %s', (kind, reasonCode, blockedReasonCode) => {
    const decision = decideExecutionOutcome({
      mode: 'direct',
      activeRunState: 'implementing',
      outcome: { kind, stdout: '', stderr: '' } as never,
      driftReasonCode: null,
      hasStdout: false
    })
    expect(decision.reasonCode).toBe(reasonCode)
    expect(decision.blockedReasonCode).toBe(blockedReasonCode)
    expect(decision.preBlockState).toBe('implementing')
  })

  it('a cancelled process leaves task state alone — cancel owns the restore', () => {
    const decision = decideExecutionOutcome({
      mode: 'direct',
      activeRunState: 'implementing',
      outcome: { kind: 'cancelled', stdout: '', stderr: '' },
      driftReasonCode: null,
      hasStdout: false
    })
    expect(decision.status).toBe('cancelled')
    expect(decision.toState).toBeNull()
  })
})

describe('hasMeaningfulOutput', () => {
  it.each([
    ['', false],
    ['  ', false],
    ['\n', false],
    ['x', true],
    ['  plan  ', true]
  ] as const)('%j -> %s', (value, expected) => {
    expect(hasMeaningfulOutput(value)).toBe(expected)
  })
})
