import { afterEach, describe, expect, it } from 'vitest'

import { createLocalPtyLaunchPlan } from './local-pty-launch-plan'

// The launch plan branches on the host platform; pin the Unix path so every host runs the same case.
const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

function planAgentAtRoot(
  options: { worktreeId?: string; workspaceRoot?: string } = {}
): ReturnType<typeof createLocalPtyLaunchPlan> {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  return createLocalPtyLaunchPlan(
    { cols: 80, rows: 24, cwd: '/', shellOverride: '/bin/bash', command: 'claude', ...options },
    () => ({})
  )
}

describe('local pty launch plan agent startup at a filesystem root', () => {
  it('starts the agent when main resolved the root as the workspace', () => {
    expect(planAgentAtRoot({ worktreeId: 'folder:7f3c1e2a', workspaceRoot: '/' })).toHaveProperty(
      'effectiveCwd',
      '/'
    )
  })

  it('refuses the agent when main resolved no workspace root', () => {
    expect(() => planAgentAtRoot()).toThrow(/requires a non-root workspace working directory/)
  })

  it('ignores a root path named only by the worktree id', () => {
    expect(() => planAgentAtRoot({ worktreeId: 'repo-1::/' })).toThrow(
      /requires a non-root workspace working directory/
    )
  })
})
