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
  // The command the launcher should exec: dev = node + cli entry, packaged = orca binary.
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
    // %* forwards the origin/handle args Chrome appends.
    writeFileSync(
      launcherPath,
      `@echo off\r\n"${options.execCommand.command}" ${quotedArgs} chat-import-host %*\r\n`
    )
    return launcherPath
  }
  const launcherPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.sh`)
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nexec "${options.execCommand.command}" ${quotedArgs} chat-import-host "$@"\n`
  )
  chmodSync(launcherPath, 0o755)
  return launcherPath
}

export function installNativeMessagingHost(options: InstallOptions): InstallResult {
  const launcherPath = writeLauncher(options)
  const manifest = buildNativeMessagingManifest({ launcherPath, extensionId: options.extensionId })

  if (options.platform === 'win32') {
    // Windows: manifest lives on disk; the registry value points Chrome at it.
    const dir = join(options.userDataPath, 'chat-import')
    const manifestPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.json`)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    options.runRegistry(
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_NAME}`,
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
