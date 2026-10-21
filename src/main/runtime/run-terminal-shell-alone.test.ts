import { describe, expect, it } from 'vitest'
import { inspectionShowsShellAlone } from './run-terminal-shell-alone'

describe('inspectionShowsShellAlone (the Windows proof)', () => {
  it('proves a shell alone only on an observed empty child census', () => {
    expect(
      inspectionShowsShellAlone({
        foregroundProcess: 'pwsh.exe',
        hasChildProcesses: false,
        childProcessEvidence: 'no-children'
      })
    ).toBe(true)
  })

  it.each([
    [
      'a child still runs',
      {
        foregroundProcess: 'node.exe',
        hasChildProcesses: true,
        childProcessEvidence: 'children' as const
      }
    ],
    [
      'the host could not read its process table',
      {
        foregroundProcess: 'pwsh.exe',
        hasChildProcesses: false,
        childProcessEvidence: 'unverifiable' as const
      }
    ],
    [
      'an older host sent no child census',
      { foregroundProcess: 'pwsh.exe', hasChildProcesses: false }
    ],
    [
      'the host could not be reached',
      {
        foregroundProcess: null,
        hasChildProcesses: false as const,
        verdict: 'unverifiable' as const,
        reason: 'timeout'
      }
    ]
  ])('stays unproven when %s', (_case, inspection) => {
    expect(inspectionShowsShellAlone(inspection)).toBe(false)
    expect(inspectionShowsShellAlone(null)).toBe(false)
  })
})
