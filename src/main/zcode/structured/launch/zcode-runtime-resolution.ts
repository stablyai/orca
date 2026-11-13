import { close as closeFd, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import type { StructuredAgentCommand } from '../../../native-chat/agent-launch/structured-agent-command-resolution'

// zcode's own app-server is the only official chat transport, but which binary to run matters:
// desktop-bundle runtimes accept the host's account-config push (their models light up), while
// npm-wrapper runtimes manage "standalone" accounts and refuse it. A start therefore launches the
// resolved CLI first and retries on a desktop runtime when the push is refused.

/** Desktop bundle runtime paths, searched in order (the desktop app spawns the same file). */
function bundledRuntimeCandidates(): string[] {
  const home = homedir()
  // The desktop bundles the runtime under its Resources tree; Linux packages share /opt and /usr.
  if (platform() === 'darwin') {
    return [
      '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
      join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs')
    ]
  }
  if (platform() === 'win32') {
    return [
      join(
        process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
        'Programs',
        'ZCode',
        'resources',
        'glm',
        'zcode.cjs'
      )
    ]
  }
  return ['/opt/ZCode/resources/glm/zcode.cjs', '/usr/share/zcode/resources/glm/zcode.cjs']
}

export function findBundledZcodeRuntime(): string | null {
  return bundledRuntimeCandidates().find((candidate) => existsSync(candidate)) ?? null
}

/**
 * The app version the gateway expects in `User-Agent: ZCode/<version>`; headless launches without
 * it are rejected even with valid auth. Read from the bundle's own metadata, never Orca's version.
 */
export function readBundledZcodeAppVersion(runtimePath: string): string | null {
  const dir = dirname(runtimePath)
  if (platform() === 'darwin') {
    for (const plist of [join(dir, '..', '..', 'Info.plist'), join(dir, '..', 'Info.plist')]) {
      try {
        const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(
          readFileSync(plist, 'utf8')
        )
        const version = match?.[1]?.trim()
        if (version) {
          return version
        }
      } catch {
        // try the next candidate location
      }
    }
  }
  for (const asar of [join(dir, '..', 'app.asar'), join(dir, '..', '..', 'app.asar')]) {
    const version = readAsarPackageVersion(asar)
    if (version) {
      return version
    }
  }
  return null
}

/** Read `package.json#version` from an Electron `app.asar` header without unpacking it. */
function readAsarPackageVersion(asarPath: string): string | null {
  let fd: number | undefined
  try {
    fd = openSyncReading(asarPath)
    const prefix = Buffer.alloc(16)
    if (readSyncTo(fd, prefix, 16) < 16) {
      return null
    }
    const headerPickleSize = prefix.readUInt32LE(4)
    const headerStringSize = prefix.readUInt32LE(12)
    if (headerStringSize <= 0 || headerStringSize > 16 * 1024 * 1024) {
      return null
    }
    const headerBuffer = Buffer.alloc(headerStringSize)
    const dataStart = 8 + headerPickleSize
    if (readSyncTo(fd, headerBuffer, headerStringSize, dataStart) < headerStringSize) {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const meta = JSON.parse(headerBuffer.toString('utf8')) as {
      files?: Record<string, { size?: number; offset?: string } | undefined>
    }
    const entry = meta.files?.['package.json']
    const size = typeof entry?.size === 'number' ? entry.size : 0
    const offset = Number(entry?.offset)
    if (!(size > 0 && size <= 1024 * 1024) || !Number.isFinite(offset)) {
      return null
    }
    const packageBuffer = Buffer.alloc(size)
    if (readSyncTo(fd, packageBuffer, size, dataStart + offset) < size) {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const version = (JSON.parse(packageBuffer.toString('utf8')) as { version?: unknown }).version
    return typeof version === 'string' && version.trim() ? version.trim() : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeFd(fd)
    }
  }
}

function openSyncReading(path: string): number {
  return openSync(path, 'r')
}

function readSyncTo(fd: number, buffer: Buffer, length: number, position = 0): number {
  return readSync(fd, buffer, 0, length, position)
}

/**
 * Provider tables the runtime needs to boot with models: the builtin table shipped beside the
 * bundle and the user's personal provider config. Both env vars must be set together — the CLI
 * uses the builtin path verbatim only when the personal one is present too.
 */
export function zcodeProviderEnv(runtimeCommand: string): Record<string, string> {
  const env: Record<string, string> = {}
  const personal = personalProviderConfigPath()
  if (personal) {
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal
  }
  const builtin = builtinProviderTablePath(runtimeCommand)
  if (builtin) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin
  }
  return env
}

function personalProviderConfigPath(): string | null {
  const override = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
  if (override) {
    return override
  }
  const candidate = join(homedir(), '.zcode', 'v2', 'provider_config.json')
  return existsSync(candidate) ? candidate : null
}

function builtinProviderTablePath(runtimeCommand: string): string | null {
  const entry = runtimeEntryPath(runtimeCommand)
  if (!entry || !(entry.endsWith('.js') || entry.endsWith('.cjs'))) {
    return null
  }
  for (const candidate of [
    join(dirname(entry), 'provider', 'zcode-builtin.json'),
    join(dirname(entry), '..', 'config', 'provider', 'zcode-builtin.json')
  ]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** Strip node/electron wrappers from a launch command to find the JS entry, if any. */
function runtimeEntryPath(command: string): string | null {
  const resolved = resolvePath(command)
  try {
    if (!statSync(resolved).isFile()) {
      return null
    }
  } catch {
    return null
  }
  return resolved
}

/**
 * The chat's primary launch when the desktop bundle is installed: its runtime under Orca's own
 * Node (Electron as Node). The desktop build accepts the host's account push, so plan models
 * light up; npm-wrapper CLIs manage standalone accounts, refuse the push, and answer with
 * wrapper-specific protocol dialects, so they only serve as the fallback when no bundle exists.
 */
export function zcodeBundledLaunch(pathEnv: string | null | undefined): {
  command: string
  prefixArgs: string[]
  args: string[]
  env: Record<string, string>
} | null {
  const runtimePath = findBundledZcodeRuntime()
  if (!runtimePath) {
    return null
  }
  const version = readBundledZcodeAppVersion(runtimePath)
  // The bundle's runtime needs a real Node (>= 22, with node:sqlite); Electron-as-Node cannot
  // resolve its @zcode/tui import and exits at boot. System installs come first.
  const node = resolveSystemNode(pathEnv)
  return {
    command: node ?? process.execPath,
    prefixArgs: [],
    args: [runtimePath],
    env: node
      ? version
        ? { ZCODE_APP_VERSION: version }
        : {}
      : {
          ELECTRON_RUN_AS_NODE: '1',
          ...(version ? { ZCODE_APP_VERSION: version } : {})
        }
  }
}

/** The newest-shaped Node a chat backend can run under, exactly as the wrapper resolves its own. */
function resolveSystemNode(pathEnv: string | null | undefined): string | null {
  const override = process.env.ZCODE_NODE?.trim()
  if (override && existsSync(override)) {
    return override
  }
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir) {
      continue
    }
    const candidate = join(dir, 'node')
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** The resolved-CLI launch, used when no desktop bundle is installed. */
export function zcodeCliLaunch(resolved: StructuredAgentCommand): {
  command: string
  prefixArgs: string[]
  args: string[]
  env: Record<string, string>
} {
  return { command: resolved.command, prefixArgs: [], args: [], env: {} }
}
