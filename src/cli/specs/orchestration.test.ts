import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'

describe('orchestration send command spec', () => {
  it('documents valid message types and the question reply path', () => {
    const sendSpec = ORCHESTRATION_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration send'
    )

    expect(sendSpec?.notes).toEqual(
      expect.arrayContaining([
        'Valid --type values: status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat.',
        'To answer a worker question, use orchestration reply --id <msg_id> --body <text> with the same Orca CLI executable.'
      ])
    )
  })
})

describe('orchestration worker-start command spec', () => {
  const startSpec = ORCHESTRATION_COMMAND_SPECS.find(
    (spec) => spec.path.join(' ') === 'orchestration worker-start'
  )

  it('offers no flag for the worker mode, because settings decide it', () => {
    expect(startSpec?.allowedFlags).not.toContain('structured')
    expect(startSpec?.usage).not.toContain('--structured')
    expect(startSpec?.notes?.join('\n')).not.toContain('--structured')
  })

  it('documents the settings default and the fallback that keeps every dispatch working', () => {
    const notes = startSpec?.notes?.join('\n') ?? ''
    expect(notes).toContain("follows the user's own setting for new agent tabs")
    expect(notes).toContain('A dispatch the setting cannot apply to still starts')
  })

  it('never points a caller at the worker kind, which nothing it runs depends on', () => {
    const notes = startSpec?.notes?.join('\n') ?? ''
    // The mode is in the receipt for operators and telemetry. Naming the field here would teach a
    // coordinator agent to branch on something no verb it runs behaves differently for.
    expect(notes).not.toMatch(/mode field/)
    expect(notes).not.toMatch(/structured chat session/)
    expect(notes).toContain('Drive every worker the same way')
  })

  it('does not promise uniformity it cannot deliver', () => {
    // The note used to promise "the same verbs, the same handle, and the same worker-read
    // sources". All three clauses were false for a worker with no terminal: `orca terminal` verbs
    // refuse its handle and `--source terminal` has nothing to serve. A spec agents read must not
    // carry a false promise — but it also must not name the worker kind, or a coordinator starts
    // branching on something no verb it runs behaves differently for. So it states the limitation
    // and the always-working alternative, without naming a mode.
    const notes = startSpec?.notes?.join('\n') ?? ''
    expect(notes).not.toContain('the same worker-read sources')
    expect(notes).toContain('Not every worker has a terminal')
    expect(notes).toContain('--source transcript')
  })
})

describe('orchestration check command spec', () => {
  it('documents --types as a wake condition rather than a batch filter', () => {
    const checkSpec = ORCHESTRATION_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration check'
    )

    expect(checkSpec?.notes).toEqual(
      expect.arrayContaining([
        '--types is the wake condition for --wait; a returned Delivery is always the whole FIFO batch, so it is never filtered by type. Only --peek and --all filter their rows.'
      ])
    )
  })
})
