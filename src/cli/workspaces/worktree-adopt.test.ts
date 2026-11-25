import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import { WORKTREE_HANDLERS } from './worktree'

function run() {
  const call = vi.fn(async () => ({ result: { message: 'Adopted.' } }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields.
  const ctx = {
    flags: new Map<string, string>([
      ['path', '/w/q'],
      ['parent-worktree', 'id:p::/w/p']
    ]),
    client: { call },
    json: true
  } as unknown as HandlerContext
  return { done: WORKTREE_HANDLERS['worktree adopt']!(ctx), call }
}

// The main-checkout refusal names a create command; it must be the launcher this CLI was run as.
describe('orca worktree adopt', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each([
    ['orca-ide', 'orca-ide'],
    ['/opt/orca/bin/orca-dev', 'orca-dev'],
    ['orca', 'orca']
  ])('sends the invoking launcher %s as %s', async (configured, cli) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('ORCA_CLI_COMMAND', configured)
    const { done, call } = run()
    await done
    expect(call).toHaveBeenCalledWith('worktree.adopt', {
      path: '/w/q',
      parentWorktree: 'id:p::/w/p',
      cliCommand: cli
    })
  })

  it('sends no launcher it cannot name, leaving the runtime default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('ORCA_CLI_COMMAND', '/tmp/some-shim')
    const { done, call } = run()
    await done
    expect(call).toHaveBeenCalledWith('worktree.adopt', {
      path: '/w/q',
      parentWorktree: 'id:p::/w/p'
    })
  })
})
