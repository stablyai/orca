import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'

// The runtime methods the workspace host actions dispatch; a rename must fail here, not at run time.
const DISPATCHED = [
  'worktree.list',
  'repo.list',
  'folderWorkspace.list',
  'worktree.activate',
  'terminal.create',
  'terminal.read',
  'agent.launch'
]

describe('plugin workspace actions', () => {
  it('dispatch only runtime methods the CLI also calls', () => {
    const names = new Set<string>(ALL_RPC_METHODS.map((method) => method.name))
    expect(DISPATCHED.filter((name) => !names.has(name))).toEqual([])
  })
})
