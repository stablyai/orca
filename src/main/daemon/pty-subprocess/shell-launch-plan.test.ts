import { afterEach, describe, expect, it } from 'vitest'

import { createPtyShellLaunchPlan } from './shell-launch-plan'

// The launch plan branches on the host platform; pin the Unix path so every host runs the same case.
const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

function planAgentAtRoot(
  sessionId: string,
  workspaceRoot?: string
): ReturnType<typeof createPtyShellLaunchPlan> {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  return createPtyShellLaunchPlan(
    {
      sessionId,
      cols: 80,
      rows: 24,
      cwd: '/',
      shellOverride: '/bin/bash',
      command: 'claude',
      workspaceRoot
    },
    {}
  )
}

describe('daemon shell launch plan agent startup at a filesystem root', () => {
  it('starts the agent when main resolved the root as the workspace', () => {
    expect(planAgentAtRoot('folder:7f3c1e2a@@abcd1234', '/').spawnCwd).toBe('/')
  })

  it('refuses the agent when main resolved no workspace root', () => {
    expect(() => planAgentAtRoot('7f3c1e2a-5b6d-4c8e-9a0f-1b2c3d4e5f60')).toThrow(
      /requires a non-root workspace working directory/
    )
  })

  it('ignores a root path named only by the session id', () => {
    expect(() => planAgentAtRoot('repo-1::/@@abcd1234')).toThrow(
      /requires a non-root workspace working directory/
    )
  })
})
