import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_MESSAGING_HOST_NAME,
  buildNativeMessagingManifest
} from './native-messaging-manifest'
import { installNativeMessagingHost } from './install-native-messaging-host'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})
function tempHome() {
  const d = mkdtempSync(join(tmpdir(), 'orca-nmh-'))
  dirs.push(d)
  return d
}

describe('buildNativeMessagingManifest', () => {
  it('produces a stdio manifest scoped to the extension origin', () => {
    const m = buildNativeMessagingManifest({ launcherPath: '/x/launch.sh', extensionId: 'abcd' })
    expect(m).toMatchObject({
      name: NATIVE_MESSAGING_HOST_NAME,
      type: 'stdio',
      path: '/x/launch.sh',
      allowed_origins: ['chrome-extension://abcd/']
    })
  })
})

describe('installNativeMessagingHost (darwin)', () => {
  it('writes an executable launcher and a manifest into the Chrome host dir', () => {
    const home = tempHome()
    const userData = join(home, 'Library', 'Application Support', 'orca')
    const result = installNativeMessagingHost({
      platform: 'darwin',
      homeDir: home,
      userDataPath: userData,
      browser: 'chrome',
      extensionId: 'abcd',
      execCommand: { command: '/usr/bin/node', args: ['/app/out/cli/index.js'] },
      runRegistry: vi.fn()
    })
    expect(existsSync(result.launcherPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(manifest.name).toBe(NATIVE_MESSAGING_HOST_NAME)
    expect(manifest.path).toBe(result.launcherPath)
    expect(result.manifestPath).toContain(
      join('Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
    )
    // launcher invokes the CLI host subcommand
    const launcher = readFileSync(result.launcherPath, 'utf8')
    expect(launcher).toContain('chat-import-host')
    // ELECTRON_RUN_AS_NODE makes a packaged Electron binary behave like
    // node; real node ignores the env var, so it's always safe to set.
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE=1')
  })
})

describe('installNativeMessagingHost (linux)', () => {
  it('writes an executable launcher and a manifest into the Chrome host dir', () => {
    const home = tempHome()
    const userData = join(home, '.config', 'orca')
    const result = installNativeMessagingHost({
      platform: 'linux',
      homeDir: home,
      userDataPath: userData,
      browser: 'chrome',
      extensionId: 'abcd',
      execCommand: { command: '/usr/bin/node', args: ['/app/out/cli/index.js'] },
      runRegistry: vi.fn()
    })
    expect(existsSync(result.launcherPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(manifest.name).toBe(NATIVE_MESSAGING_HOST_NAME)
    expect(manifest.path).toBe(result.launcherPath)
    expect(result.manifestPath).toContain(join('.config', 'google-chrome', 'NativeMessagingHosts'))
    const launcher = readFileSync(result.launcherPath, 'utf8')
    expect(launcher).toContain('chat-import-host')
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE=1')
  })
})

describe('installNativeMessagingHost (win32)', () => {
  it('writes a .cmd launcher and registers the manifest via reg add', () => {
    const home = tempHome()
    const runRegistry = vi.fn()
    const result = installNativeMessagingHost({
      platform: 'win32',
      homeDir: home,
      userDataPath: join(home, 'AppData', 'Roaming', 'orca'),
      browser: 'chrome',
      extensionId: 'abcd',
      execCommand: { command: 'C:\\app\\orca.exe', args: [] },
      runRegistry
    })
    expect(result.launcherPath.endsWith('.cmd')).toBe(true)
    const launcher = readFileSync(result.launcherPath, 'utf8')
    expect(launcher).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(runRegistry).toHaveBeenCalledWith(
      expect.stringContaining(
        `Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_NAME}`
      ),
      result.manifestPath
    )
  })

  it('registers under the Edge registry hive when --browser edge is used', () => {
    const home = tempHome()
    const runRegistry = vi.fn()
    const result = installNativeMessagingHost({
      platform: 'win32',
      homeDir: home,
      userDataPath: join(home, 'AppData', 'Roaming', 'orca'),
      browser: 'edge',
      extensionId: 'abcd',
      execCommand: { command: 'C:\\app\\orca.exe', args: [] },
      runRegistry
    })
    expect(runRegistry).toHaveBeenCalledWith(
      expect.stringContaining(
        `Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_NAME}`
      ),
      result.manifestPath
    )
  })
})
