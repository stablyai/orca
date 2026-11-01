import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { z } from 'zod'
import { expect, it } from 'vitest'

const fixtureResult = z.object({
  before: z.array(
    z.object({
      name: z.string(),
      domain: z.string(),
      path: z.string(),
      partitionKey: z
        .object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() })
        .optional()
    })
  ),
  first: z.string(),
  second: z.string(),
  after: z.array(z.object({ name: z.string(), domain: z.string() })),
  metadataPreserved: z.boolean(),
  restarted: z.array(z.string()),
  pendingPreserved: z.boolean(),
  opaque: z.literal('unverified: CDP cannot seed an opaque partition key')
})

// Two Electron startups, graceful shutdown and partition seeding need a process-level CI budget.
it('clears Google paths/partitions and preserves other sites across a graceful Electron restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-google-cookie-clear-'))
  try {
    const mainPath = join(root, 'main.cjs')
    const resultPath = join(root, 'result.json')
    const entry = `
      import { app, BrowserWindow, session } from 'electron'
      import { existsSync, readFileSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { DatabaseSync } from 'node:sqlite'
      import { browserSessionRegistry as registry } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-session-registry.ts'))}
      import { loadBrowserSessionMeta, persistBrowserSessionMeta } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-session-meta-store.ts'))}
      import { resolveChromiumCookiesPath } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/chromium-cookie-path.ts'))}
      import { clearGoogleCookiesFromPartition } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/cookies/browser-google-cookie-clear.ts'))}
      app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))})
      const deadline = setTimeout(() => app.exit(2), 30000)
      async function run() {
        await app.whenReady()
        registry.configureForOrcaProfile({ orcaProfileId: 'fixture', profileDirectory: ${JSON.stringify(root)} })
        const partition = registry.getDefaultProfile().partition
        const metadataPath = ${JSON.stringify(join(root, 'browser-session-meta.json'))}
        const meta = () => loadBrowserSessionMeta(() => metadataPath, partition)
        if (process.argv.includes('--restart')) {
          registry.applyPendingCookieImport()
          registry.initializeBrowserSessionsFromPersistedState()
          const restarted = (await session.fromPartition(partition).cookies.get({})).map(cookie => cookie.name).sort()
          const previous = JSON.parse(readFileSync(${JSON.stringify(resultPath)}, 'utf8'))
          const pendingPreserved = registry.getDefaultProfile().source?.importedAt === 1 &&
            Object.values(meta().pendingCookieImports).some(entry => entry.format === 'future-fixture' && existsSync(entry.path))
          writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ...previous, restarted, pendingPreserved }))
          clearTimeout(deadline)
          app.quit()
          return
        }
        registry.updateProfileSource('default', { browserFamily: 'manual', importedAt: 1 })
        const unrelated = await registry.createProfile('isolated', 'Pending')
        if (!unrelated) throw new Error('fixture profile unavailable')
        const pending = meta().pendingCookieImports
        pending[unrelated.partition] = { format: 'future-fixture', path: ${JSON.stringify(join(root, 'pending.sqlite'))} }
        writeFileSync(${JSON.stringify(join(root, 'pending.sqlite'))}, '')
        persistBrowserSessionMeta(() => metadataPath, partition, { pendingCookieImports: pending })
        const jar = session.fromPartition(partition)
        const window = new BrowserWindow({ show: false, webPreferences: { partition } })
        await window.loadURL('data:text/html,<title>Google cookie clear fixture</title>')
        const debug = window.webContents.debugger
        debug.attach('1.3')
        const set = async (cookie) => {
          const result = await debug.sendCommand('Network.setCookie', {
            secure: true, sameSite: 'None', value: 'fixture', expires: Date.now() / 1000 + 3600, ...cookie
          })
          if (!result.success) throw new Error('Cookie seeding failed: ' + cookie.name)
        }
        await set({ url: 'https://accounts.google.com/', name: 'twins' })
        for (const hasCrossSiteAncestor of [false, true]) {
          await set({ url: 'https://accounts.google.com/', name: 'twins',
            partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor } })
        }
        await set({ url: 'https://google.com/', domain: '.google.com', name: 'domain' })
        await set({ url: 'https://google.com/', name: 'host-only' })
        for (const path of ['/one', '/two']) {
          await set({ url: 'https://google.com' + path, path, name: 'paths' })
        }
        await set({ url: 'https://example.com/', name: 'other' })
        await set({ url: 'https://youtube.com/', name: 'youtube' })
        await set({ url: 'https://google.com.evil.example/', name: 'suffix-trap' })
        await set({ url: 'https://example.com/', name: 'other-under-google',
          partitionKey: { topLevelSite: 'https://google.com', hasCrossSiteAncestor: true } })
        const before = (await debug.sendCommand('Network.getAllCookies')).cookies
        await jar.cookies.flushStore()
        const livePath = resolveChromiumCookiesPath(join(app.getPath('userData'), 'Partitions', partition.slice(8)))
        if (!livePath) throw new Error('fixture Cookies DB unavailable')
        const database = new DatabaseSync(livePath)
        database.prepare('VACUUM INTO ?').run(${JSON.stringify(join(root, 'legacy.sqlite'))})
        database.close()
        persistBrowserSessionMeta(() => metadataPath, partition, {
          pendingCookieImports: { ...pending, [partition]: ${JSON.stringify(join(root, 'legacy.sqlite'))} }
        })
        if (!meta().defaultSource) throw new Error('fixture source missing')
        const metadataBefore = JSON.stringify(meta())
        const first = await clearGoogleCookiesFromPartition(partition)
        const metadataPreserved = JSON.stringify(meta()) === metadataBefore
        const after = (await debug.sendCommand('Network.getAllCookies')).cookies
        const second = await clearGoogleCookiesFromPartition(partition)
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, first, second, after, metadataPreserved,
          opaque: 'unverified: CDP cannot seed an opaque partition key' }))
        debug.detach()
        window.destroy()
        clearTimeout(deadline)
        await jar.cookies.flushStore()
        app.quit()
      }
      run().catch((error) => {
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: String(error?.stack || error) }))
        app.exit(1)
      })
    `
    await build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
      outfile: mainPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      // Policy hooks are outside this fixture; registry, metadata and replay execute unchanged.
      plugins: [
        {
          name: 'isolate-registry-policy-effects',
          setup(build) {
            build.onResolve({ filter: /./ }, ({ path, importer }) =>
              importer.endsWith('/browser-session-registry.ts') &&
              ![
                './browser-session-cookie-staging',
                './browser-session-meta-store',
                './browser-session-persisted-profile-validation'
              ].includes(path) &&
              !path.startsWith('../../shared/') &&
              !['electron', 'node:crypto', 'node:path'].includes(path)
                ? { path, namespace: 'registry-policy-effects' }
                : undefined
            )
            build.onLoad({ filter: /./, namespace: 'registry-policy-effects' }, () => ({
              contents: `
            const unused = async () => {};
            export { unused as forgetBrowserSessionPartitionConfiguration,
              unused as installBrowserSessionPartitionPolicies, unused as retireBrowserSessionUserAgentPolicy,
              unused as clearBrowserRoutePartitionPolicies, unused as installBrowserRoutePartitionPolicies,
              unused as retireProxySessionApplication, unused as invalidateBrowserSessionProxyApplication,
              unused as retireFailedBrowserSessionProfile, unused as cancelBrowserWebAuthnAccountRequestsForSession,
              unused as retireDeletedBrowserSessionProfile,
              unused as attachBrowserExtensionsToProfileSession,
              unused as getCanonicalUserDataPath, unused as markBrowserIdentityMigrationNoticePending,
              unused as forgetBrowserSitePermissions, unused as forgetBrowserSiteDisplay };
          `
            }))
          }
        }
      ]
    })
    const electronBinary: unknown = createRequire(import.meta.url)('electron')
    if (typeof electronBinary !== 'string') {
      throw new Error('Electron binary path unavailable')
    }
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env
    const env = {
      ...inherited,
      ORCA_BACKGROUND_LAUNCH: '1',
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root,
      XDG_CACHE_HOME: root,
      XDG_STATE_HOME: root,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      ORCA_E2E_USER_DATA_DIR: join(root, 'user-data'),
      ORCA_E2E_HOME_DIR: root,
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1'
    }
    const args = [mainPath, '--password-store=basic', '--use-mock-keychain']
    const run = spawnSync(
      process.platform === 'linux' ? 'xvfb-run' : electronBinary,
      process.platform === 'linux'
        ? ['--auto-servernum', electronBinary, ...args, '--no-sandbox']
        : args,
      { env, encoding: 'utf8', timeout: 45000 }
    )
    expect(run.error).toBeUndefined()
    expect(run.status, run.stderr).toBe(0)
    const restart = spawnSync(
      process.platform === 'linux' ? 'xvfb-run' : electronBinary,
      process.platform === 'linux'
        ? ['--auto-servernum', electronBinary, ...args, '--restart', '--no-sandbox']
        : [...args, '--restart'],
      { env, encoding: 'utf8', timeout: 45000 }
    )
    expect(restart.error).toBeUndefined()
    expect(restart.status, restart.stderr).toBe(0)
    const raw = readFileSync(resultPath, 'utf8')
    const result = fixtureResult.parse(JSON.parse(raw))
    expect(result.before.filter((cookie) => cookie.name === 'twins')).toHaveLength(3)
    expect(
      result.before
        .filter((cookie) => cookie.name === 'twins' && cookie.partitionKey)
        .map((cookie) => cookie.partitionKey?.hasCrossSiteAncestor)
        .sort()
    ).toEqual([false, true])
    expect(
      result.before
        .filter((cookie) => cookie.name === 'paths')
        .map((cookie) => cookie.path)
        .sort()
    ).toEqual(['/one', '/two'])
    expect(result.before).toHaveLength(11)
    expect(result.metadataPreserved).toBe(true)
    expect(result.pendingPreserved).toBe(true)
    expect(result.restarted).toEqual(result.after.map((cookie) => cookie.name).sort())
    expect(result.first).toBe('cleared')
    expect(result.second).toBe('empty')
    expect(result.after.map((cookie) => cookie.name).sort()).toEqual([
      'other',
      'other-under-google',
      'suffix-trap',
      'youtube'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90000)
