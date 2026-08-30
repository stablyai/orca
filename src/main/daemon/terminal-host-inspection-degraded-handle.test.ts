// A subprocess handle with no evidence channel proves nothing about the pane.
// Session must read it as `unverifiable` rather than letting the legacy
// foreground collapse reach the completion monitor as an observation
// (docs/reference/ssh-execution-boundary.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

function createEvidencelessSubprocess(readForeground: () => string | null): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 999_999_412,
    getForegroundProcess: readForeground,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn()
  } as unknown as SubprocessHandle
}

describe('daemon inspection of a handle that cannot report evidence', () => {
  const SESSION_ID = 'repo-degraded-handle::/tmp/wt@@degraded01'
  let host: TerminalHost
  let platformDescriptor: PropertyDescriptor | undefined
  let foreground: string | null

  beforeEach(async () => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    foreground = 'zsh'
    host = new TerminalHost({
      spawnSubprocess: () => createEvidencelessSubprocess(() => foreground)
    })
    await host.createOrAttach({
      sessionId: SESSION_ID,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  })

  afterEach(async () => {
    await host.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('publishes unverifiable evidence beside the unchanged legacy fields', () => {
    const result = host.inspectProcess(SESSION_ID)

    expect(result.foregroundProcess).toBe('zsh')
    expect(result.hasChildProcesses).toBe(false)
    expect(result.processEvidence?.foreground.verdict).toBe('unverifiable')
    expect(result.processEvidence?.children.verdict).toBe('unverifiable')
  })

  it('does not upgrade a named agent to observed either', () => {
    // The conservative arm cuts both ways: an unverifiable read cannot prove
    // the agent is live any more than it can prove it exited.
    foreground = 'codex'
    const result = host.inspectProcess(SESSION_ID)

    expect(result.hasChildProcesses).toBe(true)
    expect(result.processEvidence?.foreground.verdict).toBe('unverifiable')
    expect(result.processEvidence?.children.verdict).toBe('unverifiable')
  })

  it('leaves the legacy foreground read untouched', () => {
    expect(host.getForegroundProcess(SESSION_ID)).toBe('zsh')
  })
})
