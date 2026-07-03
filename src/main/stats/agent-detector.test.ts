import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDetector } from './agent-detector'

afterEach(() => {
  vi.restoreAllMocks()
})

function oscTitle(title: string): string {
  return `\x1b]0;${title}\x07`
}

describe('AgentDetector', () => {
  it('records a start when a PTY first identifies as an agent', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('✳ Claude Code'), 100)

    expect(stats.onAgentStart).toHaveBeenCalledWith('pty-1', 100)
    expect(stats.onAgentStop).not.toHaveBeenCalled()
  })

  it('does not inspect unknown non-agent output for meaningful content', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detectMeaningfulContent = vi.fn(() => true)
    const detector = new AgentDetector(stats as never, detectMeaningfulContent)

    detector.onData('pty-1', '\x1b[2K\x1b[1G'.repeat(100), 100)

    expect(detectMeaningfulContent).not.toHaveBeenCalled()
    expect(stats.onAgentStart).not.toHaveBeenCalled()
    expect(stats.onAgentStop).not.toHaveBeenCalled()
  })

  it('inspects content once when an agent title starts a session', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detectMeaningfulContent = vi.fn(() => true)
    const detector = new AgentDetector(stats as never, detectMeaningfulContent)

    detector.onData('pty-1', `${oscTitle('⠂ Writing patch')}real output`, 100)

    expect(detectMeaningfulContent).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStart).toHaveBeenCalledWith('pty-1', 100)
  })

  it('stops a session on working to idle transition using the last meaningful output time', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('✳ Claude Code'), 100)
    detector.onData('pty-1', `${oscTitle('⠂ Writing patch')}real output`, 120)
    detector.onData('pty-1', '\x1b[2K', 130)
    detector.onData('pty-1', oscTitle('✳ Claude Code'), 140)

    expect(stats.onAgentStart).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })

  it('starts a new session when an idle agent becomes working again in the same PTY', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('✳ Claude Code'), 100)
    detector.onData('pty-1', `${oscTitle('⠂ First task')}first`, 120)
    detector.onData('pty-1', oscTitle('✳ Claude Code'), 140)
    detector.onData('pty-1', `${oscTitle('⠂ Second task')}second`, 200)

    expect(stats.onAgentStart).toHaveBeenCalledTimes(2)
    expect(stats.onAgentStart).toHaveBeenNthCalledWith(1, 'pty-1', 100)
    expect(stats.onAgentStart).toHaveBeenNthCalledWith(2, 'pty-1', 200)
    expect(stats.onAgentStop).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })

  it('records lifecycle transitions from split OSC titles', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', '\x1b]0;Codex work', 100)
    detector.onData('pty-1', 'ing\x07', 101)
    detector.onData('pty-1', 'meaningful output', 120)
    detector.onData('pty-1', '\x1b]0;Codex do', 140)
    detector.onData('pty-1', 'ne\x07', 141)

    expect(stats.onAgentStart).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStart).toHaveBeenCalledWith('pty-1', 101)
    expect(stats.onAgentStop).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })

  it('does not treat an ST-split OSC title as meaningful output', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('Codex working'), 100)
    detector.onData('pty-1', 'real output', 120)
    detector.onData('pty-1', '\x1b]0;Codex done\x1b', 140)
    detector.onData('pty-1', '\\', 141)

    expect(stats.onAgentStop).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })

  it('does not treat split ST-terminated string controls as meaningful output', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('Codex working'), 100)
    detector.onData('pty-1', 'real output', 120)
    detector.onData('pty-1', '\x1b_Gi=31337,s=1,', 140)
    detector.onData('pty-1', 'v=1,a=q,t=d,f=24;AAAA\x1b\\', 141)
    detector.onData('pty-1', oscTitle('Codex done'), 160)

    expect(stats.onAgentStop).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })

  it('treats non-ASCII output in escaped chunks as meaningful', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('Codex working'), 100)
    detector.onData('pty-1', '\x1b[32m修正中 🌊\x1b[0m', 120)
    detector.onData('pty-1', oscTitle('Codex done'), 140)

    expect(stats.onAgentStop).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })

  it('detects meaningful output in large CRLF chunks without regex replacement passes', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('Codex working'), 100)
    detector.onData('pty-1', `${'\r\n'.repeat(20_000)}done`, 120)
    detector.onData('pty-1', oscTitle('Codex done'), 140)

    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
    const usedFullReplacement = replaceSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        (pattern.source === '\\r\\n' || pattern.source.includes('\\x1b'))
    )
    expect(usedFullReplacement).toBe(false)
  })

  it('ignores large incomplete OSC payloads without regex replacement passes', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('Codex working'), 100)
    detector.onData('pty-1', 'real output', 120)
    detector.onData('pty-1', `\x1b]0;${'pasted noise'.repeat(20_000)}`, 140)
    detector.onData('pty-1', oscTitle('Codex done'), 160)

    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
    const usedAnsiReplacement = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source.includes('\\x1b')
    )
    expect(usedAnsiReplacement).toBe(false)
  })

  it('keeps capped split OSC title tails from becoming meaningful output', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', oscTitle('Codex working'), 100)
    detector.onData('pty-1', 'real output', 120)
    detector.onData('pty-1', `\x1b]0;${'x'.repeat(5000)}`, 140)
    detector.onData('pty-1', ' Codex done\x07', 141)

    expect(stats.onAgentStop).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })

  it('preserves a trailing escape after a completed OSC title for stats detection', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', '\x1b]0;bash\x07\x1b', 100)
    detector.onData('pty-1', ']0;Codex working\x07', 101)

    expect(stats.onAgentStart).toHaveBeenCalledTimes(1)
    expect(stats.onAgentStart).toHaveBeenCalledWith('pty-1', 101)
    expect(stats.onAgentStop).not.toHaveBeenCalled()
  })

  it('stops an active session on PTY exit', () => {
    const stats = {
      onAgentStart: vi.fn(),
      onAgentStop: vi.fn()
    }
    const detector = new AgentDetector(stats as never)

    detector.onData('pty-1', `${oscTitle('⠂ Writing patch')}real output`, 100)
    detector.onData('pty-1', 'more output', 120)
    detector.onExit('pty-1')

    expect(stats.onAgentStart).toHaveBeenCalledWith('pty-1', 100)
    expect(stats.onAgentStop).toHaveBeenCalledWith('pty-1', 120)
  })
})
