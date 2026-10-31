import { describe, expect, it } from 'vitest'
import {
  capturePosixPaneAgent,
  paneHasNoRecognizedAgent,
  type PaneProcessRow
} from './pane-agent-identity-posix'

const shell: PaneProcessRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  tpgid: 200,
  tty: '16',
  stat: 'Ss',
  command: '/bin/zsh',
  startTime: '9:1'
}
const agent: PaneProcessRow = {
  pid: 200,
  ppid: 100,
  pgid: 200,
  tpgid: 200,
  tty: '16',
  stat: 'S+',
  command: 'claude',
  startTime: '9:2',
  hookStartTime: 'Sat Oct 31 10:00:00 2026'
}
const job: PaneProcessRow = {
  pid: 300,
  ppid: 100,
  pgid: 300,
  tpgid: 200,
  tty: '16',
  stat: 'S',
  command: 'npm run dev',
  startTime: '9:3'
}

describe('exact pane agent selection', () => {
  it('selects only the recognized agent beside an unrelated job and rejects two agents', () => {
    expect(capturePosixPaneAgent([shell, agent, job], 100, 'claude')?.agent.pid).toBe(200)
    expect(() =>
      capturePosixPaneAgent([shell, agent, { ...job, command: 'codex' }], 100, 'claude')
    ).toThrow('agent_session_operation_invalid')
    expect(paneHasNoRecognizedAgent([shell, job], 100)).toBe(true)
    expect(paneHasNoRecognizedAgent([shell, agent, job], 100)).toBe(false)
  })

  it('never targets vim from a retained conversation, an exec-replaced shell, or a mismatching hook process', () => {
    expect(capturePosixPaneAgent([shell, { ...agent, command: 'vim' }], 100, 'claude')).toBeNull()
    expect(() => capturePosixPaneAgent([{ ...shell, command: 'claude' }], 100, 'claude')).toThrow(
      'agent_session_operation_invalid'
    )
    expect(() =>
      capturePosixPaneAgent([shell, agent], 100, 'claude', {
        pid: 200,
        platform: 'darwin',
        startTime: 'wrong'
      })
    ).toThrow('hook process changed')
  })
})

it('captures a pure script wrapper across its nested PTY without confusing it with the source shell', () => {
  const wrapper = {
    ...agent,
    pid: 150,
    ppid: 100,
    command: '/usr/bin/script -q /dev/null',
    startTime: '9:2'
  }
  const inner = { ...agent, ppid: 150, tty: '32', stat: 'Ss+', startTime: '9:3' }
  const captured = capturePosixPaneAgent([shell, wrapper, inner], 100, 'claude', {
    pid: 200,
    platform: 'darwin',
    startTime: inner.hookStartTime!
  })
  expect(captured?.stopRoot).toEqual({ pid: 150, startTime: '9:2' })
  expect(captured?.targets?.map((row) => row.pid)).toEqual([150, 200])
  expect(captured?.tty).toBe('16')
  expect(captured?.agentTty).toBe('32')
})
