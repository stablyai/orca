import { describe, expect, it } from 'vitest'
import { RuntimeClientError } from '../runtime/connection/types'
import { refuseRemovalFromOwnTerminal } from './worktree-removal-caller-terminal-refusal'

const target = { id: 'repo-1::/work/probe', path: '/work/probe', hostId: 'local' as const }

const terminals: Record<string, { worktreeId: string; executionHostId: 'local' | 'ssh:box' }> = {
  term_self: { worktreeId: 'repo-1::/work/probe', executionHostId: 'local' },
  term_folder: { worktreeId: 'folder:f1', executionHostId: 'local' },
  term_twin: { worktreeId: 'repo-1::/work/probe', executionHostId: 'ssh:box' }
}
const lookupFailures: Record<string, string> = {
  structworker_1: 'terminal_unsupported_for_agent_session',
  term_unreachable: 'runtime_unavailable'
}

const host = {
  isRemote: false,
  call: async (_method: 'terminal.show', params: { terminal: string }) => {
    const terminal = terminals[params.terminal]
    if (!terminal) {
      const code = lookupFailures[params.terminal] ?? 'terminal_handle_stale'
      throw new RuntimeClientError(code, code)
    }
    return { result: { terminal } }
  }
}

describe('refuseRemovalFromOwnTerminal', () => {
  it('refuses when the calling terminal belongs to the workspace being removed', async () => {
    await expect(refuseRemovalFromOwnTerminal(host, target, 'term_self')).rejects.toMatchObject({
      code: 'caller_terminal_in_target_workspace',
      message: expect.stringContaining('term_self')
    })
    await expect(
      refuseRemovalFromOwnTerminal(host, { id: 'folder:f1' }, 'term_folder')
    ).rejects.toMatchObject({ code: 'caller_terminal_in_target_workspace' })
  })

  it('lets removal proceed when the caller is not in that workspace', async () => {
    await expect(refuseRemovalFromOwnTerminal(host, target, 'term_twin')).resolves.toBeUndefined()
    await expect(refuseRemovalFromOwnTerminal(host, target, '')).resolves.toBeUndefined()
  })

  it('skips the check only when the handle names no terminal', async () => {
    await expect(
      refuseRemovalFromOwnTerminal(host, target, 'structworker_1')
    ).resolves.toBeUndefined()
    await expect(
      refuseRemovalFromOwnTerminal(host, target, 'term_unreachable')
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })
  })
})
