import { afterEach, describe, expect, it } from 'vitest'

import { createLocalPtyLaunchPlan } from './local-pty-launch-plan'

// The launch plan branches on the host platform; pin the Unix path so every host runs the same case.
const originalPlatform = process.platform

function stubPlatformDarwin(): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('local pty launch plan automatic agent startup cwd', () => {
  it('builds a plan when the workspace working directory is a filesystem root (#42920)', () => {
    stubPlatformDarwin()
    const plan = createLocalPtyLaunchPlan(
      {
        cols: 80,
        rows: 24,
        cwd: '/',
        shellOverride: '/bin/bash',
        command: "claude '--dangerously-skip-permissions' '--resume' '2b7a50c6-2536-434c-a807'"
      },
      () => ({})
    )
    expect(plan).toHaveProperty('effectiveCwd', '/')
  })
})
