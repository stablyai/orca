import { describe, expect, it } from 'vitest'
import type { AgentSessionShellOutputChunk } from '../../../../../../shared/rpc-contract/structured-agent-session-shell-command-params'
import { createShellOutputStream, shellOutputTail } from './structured-agent-session-shell-output'

describe('createShellOutputStream', () => {
  it('keeps order across streams and strips a color split between chunks', () => {
    const frames: AgentSessionShellOutputChunk[][] = []
    const output = createShellOutputStream((chunks) => frames.push(chunks), 1024)
    output.push('stdout', Buffer.from('one \u001b[3'))
    output.push('stdout', Buffer.from('1mred\u001b[0m\n'))
    output.push('stderr', Buffer.from('oops\n'))
    output.push('stdout', Buffer.from('two\n'))
    expect(output.finish()).toEqual({ overflowed: false })
    expect(frames.flat()).toEqual([
      { stream: 'stdout', text: 'one red\n' },
      { stream: 'stderr', text: 'oops\n' },
      { stream: 'stdout', text: 'two\n' }
    ])
  })

  it('stops streaming once the byte budget is spent', () => {
    const frames: AgentSessionShellOutputChunk[][] = []
    const output = createShellOutputStream((chunks) => frames.push(chunks), 4)
    output.push('stdout', 'abcdef')
    expect(output.finish()).toEqual({ overflowed: true })
    expect(frames).toEqual([])
  })
})

describe('shellOutputTail', () => {
  it('starts a capped stream at its first whole line', () => {
    expect(shellOutputTail('0\n56311\n56312\n', '', 14)).toEqual([
      { stream: 'stdout', text: '56311\n56312\n' }
    ])
  })

  it('keeps an uncapped stream whole', () => {
    expect(shellOutputTail('a\nb\n', 'warn\n', 16)).toEqual([
      { stream: 'stdout', text: 'a\nb\n' },
      { stream: 'stderr', text: 'warn\n' }
    ])
  })
})
