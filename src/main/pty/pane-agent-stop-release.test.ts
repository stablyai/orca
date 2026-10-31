import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  capturePaneAgentStopRelease,
  paneAgentStopLineageRoot,
  paneAgentStopReleaseAdmits
} from './pane-agent-stop-release'

const row = (pid: number, ppid: number, command: string): ProcessTableRow => ({
  pid,
  ppid,
  command,
  startTime: String(pid),
  stat: 'S',
  pgid: 10,
  tpgid: 10
})
const identity = (pid: number) => ({ pid, startTime: String(pid) })
const shell = row(10, 1, '/bin/bash')
const agent = row(20, 10, 'claude')
const job = row(30, 10, 'node server.js')

describe('scoped stop survivor proof', () => {
  it.each(['posix', 'win32'] as const)(
    'admits repeated acquisitions and survivor churn on %s, but refuses an opaque relaunch',
    (platform) => {
      const proof = capturePaneAgentStopRelease([shell, agent, job], {
        root: identity(10),
        shell: identity(10),
        agent: identity(20),
        platform
      })
      expect(paneAgentStopReleaseAdmits([shell, agent, job], proof, new Set([20]))).toBe(true)
      expect(paneAgentStopReleaseAdmits([shell, job], proof)).toBe(true)
      expect(
        paneAgentStopReleaseAdmits([shell, job, { ...agent, stat: 'Z', command: '' }], proof)
      ).toBe(true)
      expect(paneAgentStopReleaseAdmits([shell, job, row(40, 30, 'worker')], proof)).toBe(true)
      expect(paneAgentStopReleaseAdmits([shell, job, row(41, 30, 'worker')], proof)).toBe(true)
      expect(paneAgentStopReleaseAdmits([shell, job, row(50, 10, 'renamed-agent')], proof)).toBe(
        false
      )
      expect(paneAgentStopReleaseAdmits([shell, { ...job, startTime: '99' }], proof)).toBe(false)
      expect(paneAgentStopReleaseAdmits([shell, job, row(50, 30, 'codex')], proof)).toBe(false)
    }
  )

  it('keeps Git Bash shell plumbing inspected rather than releasing its whole subtree', () => {
    const bash = row(15, 10, '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')
    const proof = capturePaneAgentStopRelease([shell, bash, { ...agent, ppid: 15 }, job], {
      root: identity(10),
      shell: identity(10),
      agent: identity(20),
      platform: 'win32'
    })
    expect(
      paneAgentStopLineageRoot([shell, bash, { ...agent, ppid: 15 }], 10, identity(20))
    ).toEqual(identity(20))
    expect(paneAgentStopReleaseAdmits([shell, bash, job], proof)).toBe(true)
    expect(paneAgentStopReleaseAdmits([shell, bash, job, row(50, 15, 'opaque-agent')], proof)).toBe(
      false
    )
  })

  it('captures pure launch wrappers, refusing a wrapper that owns unrelated work', () => {
    const wrappers = [row(15, 10, 'npx'), row(16, 15, 'node wrapper.js')]
    const rows = [shell, ...wrappers, { ...agent, ppid: 16 }]
    expect(paneAgentStopLineageRoot(rows, 10, identity(20))).toEqual(identity(15))
    expect(() =>
      paneAgentStopLineageRoot([...rows, row(40, 15, 'server')], 10, identity(20))
    ).toThrow('wrapper owns other work')
    expect(() =>
      capturePaneAgentStopRelease([shell, agent, row(40, 10, 'codex')], {
        root: identity(10),
        shell: identity(10),
        agent: identity(20),
        platform: 'posix'
      })
    ).toThrow('another pane agent')
  })
})

it('predicts refusal before stopping a background agent beside another foreground program', () => {
  const foregroundShell = { ...shell, tpgid: 40, tty: 'tty' }
  const foreground = { ...row(40, 10, 'vim'), pgid: 40, tty: 'tty' }
  const proof = capturePaneAgentStopRelease([foregroundShell, agent, foreground], {
    root: identity(10),
    shell: identity(10),
    agent: identity(20),
    platform: 'posix'
  })
  expect(
    paneAgentStopReleaseAdmits([foregroundShell, agent, foreground], proof, new Set([20]))
  ).toBe(false)
  const agentForeground = { ...foregroundShell, tpgid: 20 }
  expect(
    paneAgentStopReleaseAdmits(
      [agentForeground, { ...agent, pgid: 20, tty: 'tty' }, { ...foreground, pgid: 30 }],
      proof,
      new Set([20])
    )
  ).toBe(true)
  expect(
    paneAgentStopReleaseAdmits(
      [agentForeground, { ...agent, pgid: 20, tty: 'tty' }, { ...foreground, pgid: 20 }],
      proof,
      new Set([20])
    )
  ).toBe(false)
})
