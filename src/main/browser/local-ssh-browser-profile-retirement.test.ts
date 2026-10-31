import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type TestSession = {
  partition: string
  clearStorageData: ReturnType<typeof vi.fn>
  clearCache: ReturnType<typeof vi.fn>
  setProxy: ReturnType<typeof vi.fn>
  closeAllConnections: ReturnType<typeof vi.fn>
  resolveProxy: ReturnType<typeof vi.fn>
}
type TestGuest = { session: TestSession; isDestroyed(): boolean; close(): void }
const state = vi.hoisted(() => {
  const directories: string[] = []
  const guests: TestGuest[] = []
  return {
    directory: '',
    directories,
    sessions: new Map<string, TestSession>(),
    guests,
    retain: vi.fn(async () => ({ host: '127.0.0.1', port: 1080 })),
    probe: vi.fn(async () => 'ok'),
    closeTarget: vi.fn(async () => {}),
    policy: vi.fn(async () => {}),
    clearPolicy: vi.fn()
  }
})
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  state.directory = mkdtempSync(join(tmpdir(), 'ssh-profile-retirement-'))
  state.directories.push(state.directory)
  return {
    app: Object.assign(new EventEmitter(), { getPath: () => state.directory }),
    session: {
      fromPartition(partition: string) {
        let session = state.sessions.get(partition)
        if (!session) {
          session = {
            partition,
            clearStorageData: vi.fn(async () => {}),
            clearCache: vi.fn(async () => {}),
            setProxy: vi.fn(async () => {}),
            closeAllConnections: vi.fn(async () => {}),
            resolveProxy: vi.fn(async () => 'SOCKS5 127.0.0.1:1080')
          }
          state.sessions.set(partition, session)
        }
        return session
      }
    },
    webContents: { getAllWebContents: () => state.guests }
  }
})
vi.mock('./browser-session-cookie-staging', () => ({
  applyPendingBrowserCookieImports() {},
  clearPendingBrowserCookieImport() {}
}))
vi.mock('./browser-session-partition-policies', () => ({
  installBrowserSessionPartitionPolicies: state.policy,
  clearBrowserSessionPartitionPolicies: state.clearPolicy,
  forgetBrowserSessionPartitionConfiguration() {},
  retireBrowserSessionUserAgentPolicy() {}
}))
vi.mock('./browser-session-proxy', () => ({ invalidateBrowserSessionProxyApplication() {} }))
vi.mock('../network/proxy-settings', () => ({ async retireProxySessionApplication() {} }))
vi.mock('./browser-webauthn-account-picker', () => ({
  cancelBrowserWebAuthnAccountRequestsForSession() {}
}))
vi.mock('./extensions/browser-extension-session-loader', () => ({
  attachBrowserExtensionsToProfileSession() {},
  async detachBrowserExtensionsFromProfileSession() {}
}))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => state.directory
}))
vi.mock('./browser-identity-mode-store', () => ({
  async markBrowserIdentityMigrationNoticePending() {}
}))
vi.mock('./browser-site-permission-store', () => ({ forgetBrowserSitePermissions() {} }))
vi.mock('./browser-site-display-store', () => ({ forgetBrowserSiteDisplay() {} }))
vi.mock('./browser-route-webrtc-policy', () => ({ enforceBrowserRouteWebRtcPolicy() {} }))
vi.mock('./local-ssh-browser-route', () => ({
  retainLocalSshBrowserRoute: state.retain,
  probeLocalSshBrowserRouteForwarding: state.probe,
  closeLocalSshBrowserRouteForTarget: state.closeTarget
}))

import { session } from 'electron'
import { browserSessionRegistry as registry } from './browser-session-registry'
import {
  configureBrowserRoutePartitionBindingsForOrcaProfile,
  currentBrowserRoutePartitionBindingStore
} from './browser-route-partition-binding-runtime'
import { isBrowserRoutePartitionRetainedByAnyOwner } from './browser-route-partition-retention'
import {
  isLocalSshBrowserPartition,
  prepareLocalSshBrowserPartition,
  releaseLocalSshBrowserPartitionsForTarget
} from './local-ssh-browser-partitions'

beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'ssh-profile-retirement-'))
  state.directories.push(state.directory)
  state.guests.length = 0
  state.policy.mockReset().mockResolvedValue(undefined)
  state.clearPolicy.mockReset()
  state.retain.mockClear()
  state.probe.mockReset().mockResolvedValue('ok')
  state.closeTarget.mockClear()
  const options = { orcaProfileId: 'default', profileDirectory: state.directory }
  registry.configureForOrcaProfile(options)
  configureBrowserRoutePartitionBindingsForOrcaProfile(options)
})
afterAll(() => {
  for (const directory of state.directories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function profile(label: string) {
  const created = await registry.createProfile('isolated', label)
  if (!created) {
    throw new Error('Expected isolated profile')
  }
  return created
}
function guest(partition: string) {
  const webSession = state.sessions.get(partition)
  if (!webSession) {
    throw new Error('Expected prepared session')
  }
  let destroyed = false
  const guest = {
    session: webSession,
    isDestroyed: () => destroyed,
    close: () => {
      destroyed = true
    }
  }
  state.guests.push(guest)
  return guest
}

describe('deleted browser profile SSH partitions', () => {
  it('closes its guests and clears every target once while preserving sibling routes', async () => {
    const retired = await profile('Retired')
    const sibling = await profile('Sibling')
    const input = { targetId: 'shared-target', browserProfileId: retired.id }
    const first = await prepareLocalSshBrowserPartition(input)
    expect(await prepareLocalSshBrowserPartition({ ...input, skipProbe: true })).toEqual(first)
    const second = await prepareLocalSshBrowserPartition({ ...input, targetId: 'other-target' })
    const survivor = await prepareLocalSshBrowserPartition({
      ...input,
      browserProfileId: sibling.id
    })
    const removed = [guest(first.partition), guest(second.partition)]
    const live = guest(survivor.partition)
    for (const contents of removed) {
      contents.session.clearStorageData.mockImplementation(async () => {
        expect(contents.isDestroyed()).toBe(true)
      })
    }

    await expect(registry.deleteProfile(retired.id)).resolves.toBe(true)

    expect(removed.every((contents) => contents.isDestroyed())).toBe(true)
    for (const { partition } of [first, second]) {
      expect(isLocalSshBrowserPartition(partition)).toBe(false)
      expect(isBrowserRoutePartitionRetainedByAnyOwner(partition)).toBe(false)
      expect(session.fromPartition(partition).clearStorageData).toHaveBeenCalledTimes(1)
      expect(session.fromPartition(partition).clearCache).toHaveBeenCalledTimes(1)
      expect(currentBrowserRoutePartitionBindingStore().get(partition)).toBeNull()
    }
    await expect(prepareLocalSshBrowserPartition(input)).rejects.toThrow('profile_unavailable')
    expect(live.isDestroyed()).toBe(false)
    expect(
      await prepareLocalSshBrowserPartition({ ...input, browserProfileId: sibling.id })
    ).toEqual(survivor)
    expect(session.fromPartition(survivor.partition).clearStorageData).not.toHaveBeenCalled()
    expect(state.closeTarget).not.toHaveBeenCalled()
    expect(session.fromPartition(retired.partition).clearStorageData).toHaveBeenCalledTimes(1)
    await releaseLocalSshBrowserPartitionsForTarget(input.targetId)
  })

  it.each([false, true])(
    'retires late native setup (failure=%s) before deletion completes',
    async (failure) => {
      const retired = await profile('Late')
      const gate = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      state.policy.mockImplementationOnce(() => {
        started.resolve()
        return gate.promise
      })
      const input = { targetId: 'pending-target', browserProfileId: retired.id }
      const pending = prepareLocalSshBrowserPartition(input)
      const result = Promise.allSettled([pending])
      await started.promise
      const partition = [...currentBrowserRoutePartitionBindingStore().listBindings().keys()][0]
      if (!partition) {
        throw new Error('Expected pending binding')
      }
      let deleted = false
      const deletion = registry.deleteProfile(retired.id).then(() => {
        deleted = true
      })
      await expect(prepareLocalSshBrowserPartition(input)).rejects.toThrow('profile_unavailable')
      expect(isLocalSshBrowserPartition(partition)).toBe(false)
      expect(deleted).toBe(false)
      if (failure) {
        gate.reject(new Error('native setup failed'))
      } else {
        gate.resolve()
      }
      expect((await result)[0]?.status).toBe('rejected')
      await deletion
      expect(isBrowserRoutePartitionRetainedByAnyOwner(partition)).toBe(false)
      expect(session.fromPartition(partition).clearStorageData).toHaveBeenCalledTimes(1)
      expect(currentBrowserRoutePartitionBindingStore().get(partition)).toBeNull()
    }
  )

  it('does not wait for another profile on the same target', async () => {
    const retired = await profile('Ready')
    const survivor = await profile('Pending sibling')
    const ready = await prepareLocalSshBrowserPartition({
      targetId: 'same-target',
      browserProfileId: retired.id
    })
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    state.policy.mockImplementationOnce(() => {
      started.resolve()
      return gate.promise
    })
    const sibling = prepareLocalSshBrowserPartition({
      targetId: 'same-target',
      browserProfileId: survivor.id
    })
    await started.promise
    try {
      await expect(registry.deleteProfile(retired.id)).resolves.toBe(true)
      expect(isLocalSshBrowserPartition(ready.partition)).toBe(false)
    } finally {
      gate.resolve()
      await sibling
    }
    expect(isLocalSshBrowserPartition((await sibling).partition)).toBe(true)
    await releaseLocalSshBrowserPartitionsForTarget('same-target')
  })

  it('clears the original jar even if route cleanup fails and preserves default refusal', async () => {
    const retired = await profile('Cleanup failure')
    const route = await prepareLocalSshBrowserPartition({
      targetId: 'failed-target',
      browserProfileId: retired.id
    })
    state.clearPolicy.mockImplementationOnce(() => {
      throw new Error('policy cleanup failed')
    })
    await expect(registry.deleteProfile(retired.id)).resolves.toBe(true)
    expect(isLocalSshBrowserPartition(route.partition)).toBe(false)
    expect(session.fromPartition(route.partition).clearStorageData).toHaveBeenCalledTimes(1)
    expect(session.fromPartition(retired.partition).clearStorageData).toHaveBeenCalledTimes(1)
    await expect(registry.deleteProfile('default')).resolves.toBe(false)
    expect(registry.getProfile('default')).not.toBeNull()
  })
})
