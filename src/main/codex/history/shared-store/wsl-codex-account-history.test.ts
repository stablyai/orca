import { describe, expect, it, vi } from 'vitest'
import { WslCodexAccountHistoryLaunches } from './wsl-codex-account-history'

describe('WslCodexAccountHistoryLaunches', () => {
  it("runs a launch's own home ahead of the distro's queued background homes", async () => {
    const started: string[] = []
    let releaseFirst = (): void => {}
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const launches = new WslCodexAccountHistoryLaunches({
      runHelper: async ({ helperArgs }) => {
        const home = helperArgs[1]
        started.push(home)
        if (home === '/home/a') {
          await firstDone
        }
        return '{"result":"unshared","pendingDir":"/pending"}\n'
      },
      requireRunning: async () => {},
      subscribeStops: () => () => {}
    })
    const run = (accountHome: string, forLaunch: boolean) =>
      launches.run(
        { distro: 'Ubuntu', accountHome, storeHome: '/home/store', shared: false },
        { forLaunch }
      )

    const background = ['/home/a', '/home/b', '/home/c'].map((home) => run(home, false))
    const launched = run('/home/launched', true)
    await Promise.resolve()
    releaseFirst()
    await launched

    expect(started.slice(0, 2)).toEqual(['/home/a', '/home/launched'])
    await Promise.all(background)
    expect(started).toEqual(['/home/a', '/home/launched', '/home/b', '/home/c'])
  })

  it('skips a queued pass that a newer request for the same home replaced, and waits for that one', async () => {
    const calls: string[] = []
    let releaseFirst = (): void => {}
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let releaseReplacement = (): void => {}
    const replacementDone = new Promise<void>((resolve) => {
      releaseReplacement = resolve
    })
    const launches = new WslCodexAccountHistoryLaunches({
      runHelper: async ({ helperArgs }) => {
        calls.push(`${helperArgs[0]} ${helperArgs[1]}`)
        if (helperArgs[1] === '/home/a') {
          await firstDone
        }
        if (helperArgs[1] === '/home/b') {
          await replacementDone
        }
        return `{"result":"${helperArgs[0]}d","pendingDir":"/pending"}\n`
      },
      requireRunning: async () => {},
      subscribeStops: () => () => {}
    })
    const run = (accountHome: string, shared: boolean, forLaunch: boolean) =>
      launches.run(
        { distro: 'Ubuntu', accountHome, storeHome: '/home/store', shared },
        { forLaunch }
      )

    void run('/home/a', false, false)
    let staleSettled = false
    const staleShare = run('/home/b', true, false).then(() => {
      staleSettled = true
    })
    void run('/home/b', false, false)
    releaseFirst()
    await vi.waitFor(() => expect(calls).toEqual(['unshare /home/a', 'unshare /home/b']))

    expect(staleSettled).toBe(false)
    releaseReplacement()
    await staleShare
  })

  it("runs a newer pass ahead of background ones when it replaced a launch's pass", async () => {
    const calls: string[] = []
    let releaseFirst = (): void => {}
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const launches = new WslCodexAccountHistoryLaunches({
      runHelper: async ({ helperArgs }) => {
        calls.push(`${helperArgs[0]} ${helperArgs[1]}`)
        if (helperArgs[1] === '/home/a') {
          await firstDone
        }
        return `{"result":"${helperArgs[0]}d","pendingDir":"/pending"}\n`
      },
      requireRunning: async () => {},
      subscribeStops: () => () => {}
    })
    const run = (accountHome: string, shared: boolean, forLaunch: boolean) =>
      launches.run(
        { distro: 'Ubuntu', accountHome, storeHome: '/home/store', shared },
        { forLaunch }
      )

    void run('/home/a', false, false)
    void run('/home/c', false, false)
    const launch = run('/home/b', true, true)
    void run('/home/b', false, false)
    releaseFirst()
    await launch

    expect(calls.slice(0, 2)).toEqual(['unshare /home/a', 'unshare /home/b'])
  })
})
