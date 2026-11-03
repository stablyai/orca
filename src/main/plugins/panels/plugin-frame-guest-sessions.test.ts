import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  fromPartition: vi.fn(),
  allWebContents: vi.fn((): unknown[] => []),
  clearStorageData: vi.fn(async () => {}),
  clearCache: vi.fn(async () => {})
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app', getPath: () => mocks.userData },
  session: { fromPartition: mocks.fromPartition },
  webContents: { getAllWebContents: mocks.allWebContents }
}))

const { clearPluginFrameStorage } = await import('./plugin-frame-guest-sessions')
const { pluginFrameKey } = await import('../../../shared/plugins/frames/plugin-frame-guest')
const { bumpPluginDevRevision } = await import('../plugin-dev-revision')
const { mkdirSync, mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
mocks.userData = mkdtempSync(join(tmpdir(), 'orca-frame-partitions-'))
mkdirSync(join(mocks.userData, 'Partitions', `orca-plugin-${pluginFrameKey('acme.charts')}`), {
  recursive: true
})

describe('clearPluginFrameStorage', () => {
  it("closes the plugin's live guests, then wipes its partition's storage and cache", async () => {
    const sess = { clearStorageData: mocks.clearStorageData, clearCache: mocks.clearCache }
    mocks.fromPartition.mockReturnValue(sess)
    const order: string[] = []
    const guest = {
      session: sess,
      isDestroyed: () => false,
      close: vi.fn(() => order.push('close'))
    }
    const other = { session: {}, isDestroyed: () => false, close: vi.fn() }
    mocks.allWebContents.mockReturnValue([guest, other])
    mocks.clearStorageData.mockImplementation(async () => {
      order.push('clear')
    })
    await clearPluginFrameStorage('acme.charts')
    expect(order).toEqual(['close', 'clear'])
    expect(other.close).not.toHaveBeenCalled()
    expect(mocks.fromPartition).toHaveBeenCalledWith(
      `persist:orca-plugin-${pluginFrameKey('acme.charts')}`
    )
    expect(mocks.clearStorageData).toHaveBeenCalledOnce()
    expect(mocks.clearCache).toHaveBeenCalledOnce()
  })

  it('never creates a partition for a plugin that never opened a frame', async () => {
    mocks.fromPartition.mockClear()
    await clearPluginFrameStorage('acme.never-opened')
    expect(mocks.fromPartition).not.toHaveBeenCalled()
  })

  it('never fails the uninstall', async () => {
    mocks.fromPartition.mockImplementation(() => {
      throw new Error('session unavailable')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(clearPluginFrameStorage('acme.charts')).resolves.toBeUndefined()
  })
})

describe('revokeUnapprovedPluginFrames', () => {
  it('closes guests of a plugin no longer approved and clears a kill-listed one once', async () => {
    const { bindPluginFrameGuests, preparePluginFrameGuest, revokeUnapprovedPluginFrames } =
      await import('./plugin-frame-guest-sessions')
    let approved = true
    let killListed = false
    let refreshing = false
    const plugin = {
      pluginKey: 'acme.kill',
      rootDir: '/plugins/acme.kill',
      manifest: { contributes: { panels: [{ id: 'p', entry: 'p.html' }], customEditors: [] } }
    }
    const sess = {
      setProxy: vi.fn(async () => {}),
      protocol: { isProtocolHandled: () => true },
      webRequest: { onBeforeRequest: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      on: vi.fn(),
      setSpellCheckerEnabled: vi.fn(),
      closeAllConnections: vi.fn(async () => {}),
      clearStorageData: vi.fn(async () => {}),
      clearCache: vi.fn(async () => {})
    }
    mocks.fromPartition.mockReturnValue(sess)
    const guest = { session: sess, isDestroyed: () => false, close: vi.fn() }
    mocks.allWebContents.mockReturnValue([guest])
    bindPluginFrameGuests({
      findApprovedPlugin: (_key, allowRefreshPause) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guest setup reads only pluginKey, rootDir and manifest contributions.
        approved && (!refreshing || allowRefreshPause) ? (plugin as never) : null,
      getDiscovered: () => [{ pluginKey: 'acme.kill' }],
      onChanged: () => () => {},
      options: { getPluginKillListEntry: () => (killListed ? { reason: 'bad' } : null) }
    })
    expect(await preparePluginFrameGuest('acme.kill', 'panel', 'p')).not.toBeNull()

    await revokeUnapprovedPluginFrames()
    expect(guest.close).not.toHaveBeenCalled()
    // A refresh in flight (worker start, crash or reap) is not a revocation.
    refreshing = true
    await revokeUnapprovedPluginFrames()
    expect(guest.close).not.toHaveBeenCalled()
    refreshing = false
    approved = false
    await revokeUnapprovedPluginFrames()
    expect(guest.close).toHaveBeenCalled()
    expect(sess.clearStorageData).not.toHaveBeenCalled()
    killListed = true
    await revokeUnapprovedPluginFrames()
    await revokeUnapprovedPluginFrames()
    expect(sess.clearStorageData).toHaveBeenCalledOnce()
  })
})

describe('guest URL revision', () => {
  it('changes with an update or a dev content edit, and with nothing else', async () => {
    const { bindPluginFrameGuests, preparePluginFrameGuest } =
      await import('./plugin-frame-guest-sessions')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const rootDir = mkdtempSync(join(tmpdir(), 'orca-frame-rev-'))
    writeFileSync(join(rootDir, 'p.html'), 'one')
    let contentHash: string | null = null
    const plugin = () => ({
      pluginKey: 'acme.rev',
      rootDir,
      contentHash,
      manifest: { contributes: { panels: [{ id: 'p', entry: 'p.html' }], customEditors: [] } }
    })
    bindPluginFrameGuests({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guest setup reads only pluginKey, rootDir, contentHash and contributions.
      findApprovedPlugin: () => plugin() as never,
      getDiscovered: () => [{ pluginKey: 'acme.rev' }],
      onChanged: () => () => {},
      options: {}
    })
    const url = async () => (await preparePluginFrameGuest('acme.rev', 'panel', 'p'))?.url
    const first = await url()
    expect(first).toMatch(/\/p\.html\?rev=dev-[0-9a-f]{8}-0$/)
    expect(await url()).toBe(first)
    // Edits count only once the dev watcher reports them; the tree is never hashed.
    writeFileSync(join(rootDir, 'asset.js'), 'changed')
    expect(await url()).toBe(first)
    bumpPluginDevRevision(rootDir)
    expect(await url()).toMatch(/\?rev=dev-[0-9a-f]{8}-1$/)
    contentHash = 'a'.repeat(64)
    expect(await url()).toMatch(/\?rev=a{16}$/)
  })
})

describe('kill list and earlier runs', () => {
  it("clears a kill-listed plugin's partition from an earlier run, once, without opening it", async () => {
    const { bindPluginFrameGuests, revokeUnapprovedPluginFrames } =
      await import('./plugin-frame-guest-sessions')
    mkdirSync(join(mocks.userData, 'Partitions', `orca-plugin-${pluginFrameKey('acme.old')}`), {
      recursive: true
    })
    const sess = { clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}) }
    mocks.fromPartition.mockReset()
    mocks.fromPartition.mockReturnValue(sess)
    mocks.allWebContents.mockReturnValue([])
    bindPluginFrameGuests({
      findApprovedPlugin: () => null,
      getDiscovered: () => [{ pluginKey: 'acme.old' }, { pluginKey: 'acme.never-opened' }],
      onChanged: () => () => {},
      options: { getPluginKillListEntry: () => ({ reason: 'bad' }) }
    })
    await revokeUnapprovedPluginFrames()
    await revokeUnapprovedPluginFrames()
    expect(mocks.fromPartition).toHaveBeenCalledOnce()
    expect(mocks.fromPartition).toHaveBeenCalledWith(
      `persist:orca-plugin-${pluginFrameKey('acme.old')}`
    )
    expect(sess.clearStorageData).toHaveBeenCalledOnce()
  })
})
