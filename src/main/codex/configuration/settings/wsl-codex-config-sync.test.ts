import { describe, expect, it, vi } from 'vitest'

const { helperRuns } = vi.hoisted(() => {
  const release: (() => void)[] = []
  return { helperRuns: { count: 0, release } }
})

vi.mock('../../../wsl/execution/wsl-guest-node-helper', () => ({
  runWslGuestNodeHelper: async (args: { helperArgs: readonly string[] }) => {
    helperRuns.count += 1
    await new Promise<void>((resolve) => helperRuns.release.push(resolve))
    const homes = args.helperArgs.flatMap((arg, index, all) =>
      all[index - 1] === '--runtime-home' ? [arg] : []
    )
    return JSON.stringify({
      protocol: 1,
      homes: homes.map((runtimeHome) => ({
        runtimeHome,
        complete: true,
        status: { state: 'synced', reason: null, systemConfigPath: '' },
        error: null,
        warnings: []
      }))
    })
  }
}))

vi.mock('../../../wsl/filesystem/wsl-unc-access-gate', () => ({
  assertWslUncPathRunning: async () => {},
  WslDistroStoppedError: class extends Error {},
  WslDistroUnverifiableError: class extends Error {}
}))

import { syncWslCodexConfigInDistro } from './wsl-codex-config-sync'

const request = (distro: string, home: string, forLaunch = true) =>
  syncWslCodexConfigInDistro({
    distro,
    linuxSystemHome: '/home/u/.codex',
    homes: [{ runtimeHomePath: `\\\\wsl.localhost\\${distro}${home}`, linuxRuntimeHome: home }],
    forLaunch
  })

// Drains every held helper run, including ones a release lets start.
async function releaseAll(): Promise<void> {
  for (let idle = 0; idle < 5; idle++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const held = helperRuns.release.splice(0)
    idle = held.length > 0 ? 0 : idle
    held.forEach((resume) => resume())
  }
}

describe('WSL Codex settings sync requests', () => {
  it.each([10, 100])(
    'a burst of %i launches into one home runs the helper at most twice',
    async (n) => {
      helperRuns.count = 0
      const distro = `Burst${n}`
      // The first starts at once and is held; the rest arrive while it runs.
      const passes = Array.from({ length: n }, () => request(distro, '/home/u/acct/home'))
      // A different home set still gets its own run.
      passes.push(request(distro, '/home/u/other/home'))
      await releaseAll()
      await Promise.all(passes)
      expect(helperRuns.count).toBe(3)
    }
  )

  it('a launch that takes over a queued background pass runs once for both', async () => {
    helperRuns.count = 0
    const passes = [
      request('Promote', '/home/u/busy/home'),
      request('Promote', '/home/u/acct/home', false),
      request('Promote', '/home/u/acct/home')
    ]
    await releaseAll()
    await Promise.all(passes)
    expect(helperRuns.count).toBe(2)
  })
})
