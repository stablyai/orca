import { describe, expect, it, vi } from 'vitest'
import type { AgentContextReport } from '../../shared/agent-context'

type InspectArgs = {
  target: AgentContextReport['target']
  toAccessPath?: (displayPath: string) => string
  pathApi?: { join: (...parts: string[]) => string }
}

const inspectAgentContext = vi.hoisted(() =>
  vi.fn(
    async (_args: unknown): Promise<AgentContextReport> => ({
      target: { kind: 'native-host', homeDir: '', cwd: null },
      instructionFiles: [],
      mcpFiles: [],
      hookFiles: [],
      plugins: [],
      scannedAt: 0
    })
  )
)
vi.mock('./agent-context-inspection', () => ({ inspectAgentContext }))
vi.mock('node:os', () => ({ homedir: () => '/home/native' }))

import { inspectAgentContextOnTarget } from './agent-context-target'

describe('inspectAgentContextOnTarget', () => {
  it('reads WSL targets through the UNC mount with POSIX display paths', async () => {
    await inspectAgentContextOnTarget({
      kind: 'wsl',
      distro: 'Ubuntu',
      homeDir: '/home/u',
      cwd: '/home/u/repo'
    })
    const args = inspectAgentContext.mock.calls.at(-1)?.[0] as InspectArgs
    expect(args.target).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      homeDir: '/home/u',
      cwd: '/home/u/repo'
    })
    expect(args.toAccessPath?.('/home/u/.claude/CLAUDE.md')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude\\CLAUDE.md'
    )
    expect(args.toAccessPath?.('/mnt/c/src/repo/AGENTS.md')).toBe('C:\\src\\repo\\AGENTS.md')
    // Why: sources must be built with POSIX joins even when Orca runs on Windows.
    expect(args.pathApi?.join('/home/u', '.codex', 'config.toml')).toBe(
      '/home/u/.codex/config.toml'
    )
  })

  it('reads native targets from the local home directory', async () => {
    await inspectAgentContextOnTarget({ kind: 'native-host', cwd: undefined })
    const args = inspectAgentContext.mock.calls.at(-1)?.[0] as InspectArgs
    expect(args.target).toEqual({ kind: 'native-host', homeDir: '/home/native', cwd: null })
    expect(args.toAccessPath).toBeUndefined()
  })
})
