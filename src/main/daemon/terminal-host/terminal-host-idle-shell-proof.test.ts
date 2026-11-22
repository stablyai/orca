import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'
import { rememberIdleShellProof } from './terminal-host-idle-shell-proof'

function shellSession(rootPid: number, shellIsRootChild: boolean): Session {
  const fields = { pid: rootPid, shellIsRootChild, getForegroundProcess: () => 'zsh' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proof reads only these three session fields.
  return fields as unknown as Session
}

const shell: ProcessTableRow = {
  pid: 1876,
  ppid: 1866,
  pgid: 1876,
  tpgid: 1876,
  stat: 'Ss+',
  command: '-zsh'
}

describe('rememberIdleShellProof', () => {
  it('proves a macOS shell idle under its login wrapper, which keeps its own group on the terminal', () => {
    const login: ProcessTableRow = {
      pid: 1866,
      ppid: 1,
      pgid: 1866,
      tpgid: 1876,
      stat: 'Ss',
      command: 'login -pfl user /bin/zsh'
    }
    expect(rememberIdleShellProof(shellSession(1866, true), [login, shell], 0, 0)).toBe(true)
  })

  it("does not prove a shell idle from a capture older than the pane's latest input or output", () => {
    // A keystroke may have forked a child after a capture another pane shared had already started.
    expect(rememberIdleShellProof(shellSession(1876, false), [shell], 0, 0, false)).toBe(false)
  })

  it('does not prove a shell idle while it has any child, even one detached from the terminal', () => {
    // `sleep 30 & wait; aider …` and `set +m; setsid sleep 30 & wait; aider …`: the agent may follow the child.
    const backgroundJob: ProcessTableRow = {
      pid: 2000,
      ppid: 1876,
      pgid: 2000,
      tpgid: 1876,
      stat: 'S',
      command: 'sleep 30'
    }
    const detachedChild: ProcessTableRow = {
      pid: 2001,
      ppid: 1876,
      pgid: 2001,
      tpgid: -1,
      stat: 'Ss',
      command: 'sleep 30'
    }
    for (const child of [backgroundJob, detachedChild]) {
      expect(rememberIdleShellProof(shellSession(1876, false), [shell, child], 0, 0)).toBe(false)
    }
  })
})
