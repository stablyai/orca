import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../workspace-ports/workspace-port-block-registry', () => ({
  getWorkspacePortBlockForWorktreeId: async (worktreeId: string) =>
    worktreeId.endsWith('/a') ? { base: 21000, count: 10 } : { base: 21010, count: 10 }
}))

const { stampWorkspacePortEnv, stampPtySpawnPaneEnv } = await import('./spawn-pane-env')

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('workspace port env', () => {
  it('gives each workspace its own block even when the host process has ORCA_PORT (VM launcher)', async () => {
    vi.stubEnv('ORCA_PORT', '3000')
    const a: Record<string, string> = { ORCA_PORT: '3000', CONDUCTOR_PORT: '3000' }
    const b: Record<string, string> = { ORCA_PORT: '3000', CONDUCTOR_PORT: '3000' }
    await stampWorkspacePortEnv(a, 'repo::/w/a')
    await stampWorkspacePortEnv(b, 'repo::/w/b')
    expect(a).toEqual({ ORCA_PORT: '21000', ORCA_PORT_COUNT: '10', CONDUCTOR_PORT: '21000' })
    expect(b).toEqual({ ORCA_PORT: '21010', ORCA_PORT_COUNT: '10', CONDUCTOR_PORT: '21010' })
  })

  it('scrubs an inherited block from a spawn that names no pane', () => {
    const env: Record<string, string> = {
      ORCA_PORT: '3000',
      ORCA_PORT_COUNT: '10',
      CONDUCTOR_PORT: '3000'
    }
    stampPtySpawnPaneEnv(env, { pane: null, jcodeRuntimeDir: undefined })
    expect(env.ORCA_PORT).toBeUndefined()
    expect(env.CONDUCTOR_PORT).toBeUndefined()
  })
})
