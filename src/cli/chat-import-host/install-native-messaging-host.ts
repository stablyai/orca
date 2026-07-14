import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nativeMessagingManifestPath, windowsRegistryHostKey } from './native-messaging-host-paths'
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

function writeLauncher(options: InstallOptions): string {
  const dir = join(options.userDataPath, 'chat-import')
  mkdirSync(dir, { recursive: true })
  const quotedArgs = options.execCommand.args.map((a) => `"${a}"`).join(' ')
  // Why: Chrome spawns the host with a bare environment (no ORCA_USER_DATA_PATH),
  // so orcaUserDataPath() would fall back to the release dir and the host would
  // read/write a different chats.db than the app that installed it (dev uses
  // orca-dev, release uses orca). Pin it to the installing app's userData.
  if (options.platform === 'win32') {
    const launcherPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.cmd`)
    // %* forwards the origin/handle args Chrome appends. ELECTRON_RUN_AS_NODE
    // makes a packaged Electron binary run as plain node; real node ignores
    // the env var, so setting it unconditionally is safe in dev too.
    writeFileSync(
      launcherPath,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "ORCA_USER_DATA_PATH=${options.userDataPath}"\r\n"${options.execCommand.command}" ${quotedArgs} chat-import-host %*\r\n`
    )
    return launcherPath
  }
  const launcherPath = join(dir, `${NATIVE_MESSAGING_HOST_NAME}.sh`)
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ORCA_USER_DATA_PATH="${options.userDataPath}" exec "${options.execCommand.command}" ${quotedArgs} chat-import-host "$@"\n`
  )
  chmodSync(launcherPath, 0o755)
  return launcherPath
}

export function installNativeMessagingHost(options: InstallOptions): InstallResult {
  const launcherPath = writeLauncher(options)
  const manifest = buildNativeMessagingManifest({ launcherPath, extensionId: options.extensionId })
  const manifestPath = nativeMessagingManifestPath(options)

  if (options.platform === 'win32') {
    // Windows: manifest lives on disk; the registry value under the
    // browser's own hive points that browser at it.
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    options.runRegistry(`HKCU\\${windowsRegistryHostKey(options.browser)}`, manifestPath)
    return { launcherPath, manifestPath }
  }

  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { launcherPath, manifestPath }
}
