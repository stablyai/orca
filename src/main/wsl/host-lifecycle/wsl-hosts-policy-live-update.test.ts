import '../../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/wsl-hosts-policy'
import {
  readCachedWslHostsPolicy,
  WslHostsPolicyLiveUpdater,
  wslHostsPolicyCacheFileName,
  wslHostsPolicyChannelForAppVersion
} from './wsl-hosts-policy-live-update'

const STABLE = '1.4.2'
const RC = '1.4.3-rc.1'

const policy = (revision: number, wslHosts: 'allow' | 'block'): string =>
  JSON.stringify({ version: 1, revision, wslHosts })

describe('WSL hosts policy live update', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-policy-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const respond = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }))
  const updater = (
    fetch: (url: string) => Promise<Response>,
    options: { appVersion?: string; isPackaged?: boolean; onBlock?: () => void } = {}
  ) =>
    new WslHostsPolicyLiveUpdater({
      userDataPath,
      appVersion: options.appVersion ?? STABLE,
      isPackaged: options.isPackaged ?? true,
      fetch,
      onBlock: options.onBlock
    })
  const seedCache = (text: string, appVersion = STABLE) => {
    const channel = wslHostsPolicyChannelForAppVersion(appVersion)
    if (!channel) {
      throw new Error(`no channel for ${appVersion}`)
    }
    writeFileSync(join(userDataPath, wslHostsPolicyCacheFileName(channel)), text)
  }

  // A build that doesn't know a field must not strip it for the newer build sharing the profile.
  it('caches the downloaded text verbatim, fields this build does not know included', async () => {
    const text = JSON.stringify({
      version: 1,
      revision: 3,
      wslHosts: 'block',
      someLaterField: { keep: true }
    })
    const live = updater(respond(text))
    await live.start()
    live.stop()

    const cachedText = readFileSync(
      join(userDataPath, wslHostsPolicyCacheFileName('stable')),
      'utf8'
    )
    expect(cachedText).toBe(text)
    // This build reads its own fields from it, and a newer parser still finds the later one.
    expect(readCachedWslHostsPolicy(userDataPath, STABLE)?.wslHosts).toBe('block')
    expect(JSON.parse(cachedText)).toMatchObject({ someLaterField: { keep: true } })
  })

  it('never lets a lower or equal revision replace the cache', async () => {
    seedCache(policy(5, 'block'))
    const live = updater(respond(policy(5, 'allow')))
    await live.start()
    live.stop()

    expect(readCachedWslHostsPolicy(userDataPath, STABLE)?.wslHosts).toBe('block')
  })

  it('lifts a block with a higher revision', async () => {
    seedCache(policy(5, 'block'))
    const live = updater(respond(policy(6, 'allow')))
    await live.start()
    live.stop()

    expect(readCachedWslHostsPolicy(userDataPath, STABLE)?.wslHosts).toBe('allow')
  })

  it('keeps a prerelease switch out of a stable build sharing the profile', () => {
    seedCache(policy(1, 'block'), RC)

    expect(readCachedWslHostsPolicy(userDataPath, RC)?.wslHosts).toBe('block')
    expect(readCachedWslHostsPolicy(userDataPath, STABLE)).toBeNull()
  })
})
