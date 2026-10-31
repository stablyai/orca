import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { automationAgentPrompt, automationRunReportingCli } from './automation-run-preamble'
import { resolveProjectExecutionRuntime } from '../../shared/project-execution-runtime'

const repo: Repo = {
  id: 'r1',
  path: '/work/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1
}
const noRuntime = (): undefined => undefined

describe('automationAgentPrompt', () => {
  it('leads with the run instructions and keeps the saved prompt verbatim as the task', () => {
    const prompt = automationAgentPrompt('Summarize  yesterday\n', 'orca')

    expect(prompt.endsWith('=== TASK ===\nSummarize  yesterday\n')).toBe(true)
    expect(prompt).toContain(
      'orca automations warn --key "<short-id>" --message "<what is missing>"\n'
    )
    expect(prompt).toContain('orca automations warn --key "<short-id>" --resolve\n')
    expect(prompt).toContain('orca automations attach --file "<path>"\n')
    expect(prompt).toContain("--evidence-file (sends the file's tail)")
    expect(prompt).toContain('warn if a workaround reduces coverage or quality.')
  })

  it('sends the saved prompt alone where reporting cannot reach the run', () => {
    expect(automationAgentPrompt('Summarize', null)).toBe('Summarize')
  })
})

describe('automationRunReportingCli', () => {
  it('does not advertise reporting to SSH or WSL terminals', () => {
    expect(
      automationRunReportingCli(
        { ok: true, cwd: '/work/repo', repo: { ...repo, connectionId: 'ssh-1' } },
        noRuntime
      )
    ).toBeNull()
    expect(
      automationRunReportingCli(
        { ok: true, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', repo },
        noRuntime
      )
    ).toBeNull()
    expect(
      automationRunReportingCli({ ok: true, cwd: 'C:\\work\\repo', repo }, () =>
        resolveProjectExecutionRuntime({
          appPlatform: 'win32',
          projectId: 'p1',
          projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' }
        })
      )
    ).toBeNull()
    expect(
      automationRunReportingCli({ ok: true, cwd: '/work/repo', repo }, noRuntime)
    ).not.toBeNull()
    expect(
      automationRunReportingCli({ ok: true, cwd: 'C:\\work\\repo', repo }, () =>
        resolveProjectExecutionRuntime({
          appPlatform: 'win32',
          projectId: 'p1',
          projectRuntimePreference: { kind: 'windows-host' }
        })
      )
    ).not.toBeNull()
  })
})
