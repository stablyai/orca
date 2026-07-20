import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildNativeMessagingManifest,
  NATIVE_MESSAGING_HOST_NAME
} from './native-messaging-manifest'

export type InstallBrowser = 'chrome' | 'edge' | 'brave' | 'chromium'

export type InstallOptions = {
  platform: NodeJS.Platform
  homeDir: string
  userDataPath: string
  browser: InstallBrowser
  extensionId: string
  // The command the launcher should exec — always execPath + the CLI entry
  // script; see resolveHostExecCommand for why there's no dev/packaged split.
  execCommand: { command: string; args: string[] }
  // Injected so Windows registry writes are testable.
  runRegistry: (registryKey: string, manifestPath: string) => void
}

export type InstallResult = { launcherPath: string; manifestPath: string }

// Per-browser NativeMessagingHosts directory, relative to the OS config root.
const BROWSER_DIR: Record<InstallBrowser, { darwin: string[]; linux: string[] }> = {
  chrome: { darwin: ['Google', 'Chrome'], linux: ['google-chrome'] },
  edge: { darwin: ['Microsoft Edge'], linux: ['microsoft-edge'] },
  brave: {
    darwin: ['BraveSoftware', 'Brave-Browser'],
    linux: ['BraveSoftware', 'Brave-Browser']
  },
  chromium: { darwin: ['Chromium'], linux: ['chromium'] }
}

// Per-browser registry hive under HKCU, mirroring BROWSER_DIR for Windows —
// each Chromium-based browser reads NativeMessagingHosts from its own hive.
const WINDOWS_REGISTRY_BASE: Record<InstallBrowser, string> = {
  chrome: 'Software\\Google\\Chrome',
  edge: 'Software\\Microsoft\\Edge',
  brave: 'Software\\BraveSoftware\\Brave-Browser',
  chromium: 'Software\\Chromium'
}

function hostDir(options: InstallOptions): string {
  const seg = BROWSER_DIR[options.browser]
  if (options.platform === 'darwin') {
    return join(
      options.homeDir,
      'Library',
      'Application Support',
      ...seg.darwin,
      'NativeMessagingHosts'
    )
  }
  // linux
  return join(options.homeDir, '.config', ...seg.linux, 'NativeMessagingHosts')
}

function writeLauncher(options: InstallOptions): string {
  const dir = join(options.userDataPath, 'chat-import')
  mkdirSync(dir, { recursive: true })
  const quotedArgs = options.execCommand.args.map((a) => `"${a}"`).join(' ')
  if (options.platform === 'win32') {
    const launcherPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.cmd`)
    // %* forwards the origin/handle args Chrome appends. ELECTRON_RUN_AS_NODE
    // makes a packaged Electron binary run as plain node; real node ignores
    // the env var, so setting it unconditionally is safe in dev too.
    writeFileSync(
      launcherPath,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${options.execCommand.command}" ${quotedArgs} chat-import-host %*\r\n`
    )
    return launcherPath
  }
  const launcherPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.sh`)
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${options.execCommand.command}" ${quotedArgs} chat-import-host "$@"\n`
  )
  chmodSync(launcherPath, 0o755)
  return launcherPath
}

export function installNativeMessagingHost(options: InstallOptions): InstallResult {
  const launcherPath = writeLauncher(options)
  const manifest = buildNativeMessagingManifest({ launcherPath, extensionId: options.extensionId })

  if (options.platform === 'win32') {
    // Windows: manifest lives on disk; the registry value under the
    // browser's own hive points that browser at it.
    const dir = join(options.userDataPath, 'chat-import')
    const manifestPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.json`)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    options.runRegistry(
      `HKCU\\${WINDOWS_REGISTRY_BASE[options.browser]}\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_NAME}`,
      manifestPath
    )
    return { launcherPath, manifestPath }
  }

  const dir = hostDir(options)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { launcherPath, manifestPath }
}
