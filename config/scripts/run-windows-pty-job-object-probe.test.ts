import { describe, expect, it } from 'vitest'
import {
  createUnobservedWindowsJobObjectEvidence,
  validateWindowsJobObjectEvidence
} from './run-windows-pty-job-object-probe.mjs'

describe('Windows PTY Job Object probe evidence', () => {
  it('records typed unobserved evidence with capability disabled off Windows', () => {
    const evidence = createUnobservedWindowsJobObjectEvidence('linux')
    expect(validateWindowsJobObjectEvidence(evidence, 'linux')).toMatchObject({
      status: 'unobserved',
      capability: { windows_job_object: false, exact_auto_release: false },
      probe: null
    })
  })

  it('rejects manufactured observed evidence off Windows', () => {
    const evidence = createUnobservedWindowsJobObjectEvidence('linux')
    expect(() =>
      validateWindowsJobObjectEvidence(
        {
          ...evidence,
          status: 'observed',
          capability: { ...evidence.capability, exact_auto_release: true }
        },
        'linux'
      )
    ).toThrow('capability-disabled')
  })

  it('requires descendant and restart proof on Windows', () => {
    expect(() =>
      validateWindowsJobObjectEvidence(
        {
          schema_version: 1,
          task_id: 'ORC-07W',
          status: 'observed',
          capability: { version: 1, windows_job_object: true, exact_auto_release: true },
          probe: { parent_and_grandchildren_terminated: true, restart_job_isolated: false }
        },
        'win32'
      )
    ).toThrow('does not prove')
  })
})
