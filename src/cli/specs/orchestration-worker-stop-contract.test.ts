import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from './orchestration-worker-specs'

describe('worker-stop terminal-close contract', () => {
  const workerStop = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
    (spec) => spec.path.join(' ') === 'orchestration worker-stop'
  )

  it('documents processAction as the close guarantee surface', () => {
    expect(workerStop).toBeDefined()
    expect(workerStop?.summary).toBe(
      'Fence one Dispatch; close its terminal only for the exact live supervised worker'
    )
    const notes = workerStop?.notes?.join('\n') ?? ''
    expect(notes).toContain('closed_agent_terminal')
    expect(notes).toContain('processAction')
    expect(notes).toContain('do not also run terminal close')
    expect(notes).toMatch(/none means no close/i)
    expect(notes).toMatch(/unknown means the close attempt did not complete/i)
  })
})
