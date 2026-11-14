import { describe, expect, it, vi } from 'vitest'
import { probeBranchUpstream, type GitExec } from './branch-rename'

describe('probeBranchUpstream', () => {
  it('reports probe-failed, not has-upstream, for localized git diagnostics (issue #7808)', async () => {
    // gettext can translate even Git's fatal: prefix.
    const exec: GitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/feature\n', stderr: '' }
      }
      throw new Error(
        'Command failed: git rev-parse --abbrev-ref HEAD@{u}\n' +
          "Schwerwiegend: Kein Upstream-Branch für Branch 'feature' konfiguriert."
      )
    })
    const probe = await probeBranchUpstream(exec)
    expect(probe.outcome).toBe('probe-failed')
  })
})
