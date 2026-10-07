import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

describe('readTerminalClientUse', () => {
  it('reads a spawned terminal nobody typed into or views as unused', () => {
    const runtime = new OrcaRuntimeService()
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-1' })
    runtime.terminalRunFacts.recordInput('pty-1', 'launch', 'claude "run checks"\r')
    expect(runtime.readTerminalClientUse('pty-1')).toBe('unused')
  })

  it('reads a terminal a client typed into as used', () => {
    const runtime = new OrcaRuntimeService()
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-1' })
    runtime.terminalRunFacts.recordInput('pty-1', 'driving', 'git status\r')
    expect(runtime.readTerminalClientUse('pty-1')).toBe('used')
  })

  it('reads a terminal a client is viewing as used', () => {
    const runtime = new OrcaRuntimeService()
    runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-1' })
    // What a client's terminal stream subscribe registers.
    const release = runtime.registerRemoteTerminalViewSubscriber('pty-1')
    expect(runtime.readTerminalClientUse('pty-1')).toBe('used')
    release()
    expect(runtime.readTerminalClientUse('pty-1')).toBe('unused')
  })

  it('cannot tell for a terminal this process adopted rather than spawned', () => {
    const runtime = new OrcaRuntimeService()
    expect(runtime.readTerminalClientUse('pty-adopted')).toBe('unknown')
  })
})
