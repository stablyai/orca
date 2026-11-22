import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'
import { rememberIdleShellProof } from './terminal-host-idle-shell-proof'

function shellSession(): Session {
  return {
    pid: 100,
    shellIsRootChild: false,
    getForegroundProcess: () => 'zsh'
  } as unknown as Session
}

const shell: ProcessTableRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  tpgid: 100,
  stat: 'Ss+',
  command: '-zsh'
}

describe('rememberIdleShellProof', () => {
  it('proves a shell alone on its terminal idle', () => {
    expect(rememberIdleShellProof(shellSession(), [shell], 0, 0)).toBe(true)
  })

  it('does not prove a shell waiting on a background job idle', () => {
    // `sleep 30 & wait; aider …`: the shell's group holds the terminal alone, but its job may be followed by an agent.
    const backgroundJob: ProcessTableRow = {
      pid: 200,
      ppid: 100,
      pgid: 200,
      tpgid: 100,
      stat: 'S',
      command: 'sleep 30'
    }
    expect(rememberIdleShellProof(shellSession(), [shell, backgroundJob], 0, 0)).toBe(false)
  })
})
