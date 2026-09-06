import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { isRecord, readConfig } from './chrome-devtools-config'

const PI_PACKAGES = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']
type InstalledPackage = { root: string; manifest: Record<string, unknown> }

function readPackage(root: string): InstalledPackage | null {
  const source = readConfig(join(root, 'package.json'))
  if (source === null) {
    return null
  }
  const manifest: unknown = JSON.parse(source)
  return isRecord(manifest) ? { root, manifest } : null
}

function findPackage(entry: string): InstalledPackage | null {
  let root = dirname(realpathSync(entry))
  for (let depth = 0; depth < 8; depth++) {
    const pkg = readPackage(root)
    if (pkg && typeof pkg.manifest.name === 'string' && PI_PACKAGES.includes(pkg.manifest.name)) {
      return pkg
    }
    const parent = dirname(root)
    if (parent === root) {
      break
    }
    root = parent
  }
  return null
}

function resolvePiPackage(program: string): InstalledPackage {
  const realProgram = realpathSync(program)
  const direct = findPackage(realProgram)
  if (direct) {
    return direct
  }
  // npm/pnpm shims quote the JS entry relative to their own directory; never evaluate shell text.
  if (statSync(realProgram).size <= 128 * 1024) {
    const source = readFileSync(realProgram, 'utf8')
    const entries = source.matchAll(
      /(?:\$basedir(?:_win)?|%dp0%|%~dp0)([\\/][^"'\r\n]*[\\/]@(?:earendil-works|mariozechner)[\\/]pi-coding-agent[\\/][^"'\r\n]*\.js)/g
    )
    for (const entry of entries) {
      if (/[$%`]/.test(entry[1])) {
        continue
      }
      const path = resolve(dirname(realProgram), entry[1].replace(/^[\\/]/, ''))
      try {
        const pkg = findPackage(path)
        if (pkg) {
          return pkg
        }
      } catch {
        // A platform-specific branch of a standard shim may not exist on this host.
      }
    }
  }
  throw new Error(
    'Cannot verify Pi package metadata from its executable; use a standard npm/pnpm Pi installation.'
  )
}

function resolvePeer(host: InstalledPackage, name: string): InstalledPackage {
  const requireHost = createRequire(join(host.root, 'package.json'))
  for (const root of requireHost.resolve.paths(name) ?? []) {
    const pkg = readPackage(join(root, name))
    if (pkg?.manifest.name === name) {
      return pkg
    }
  }
  throw new Error(`Cannot verify installed Pi host dependency ${name}.`)
}

export function verifyPiRuntime(
  agentDir: string,
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  configuredVersion?: string
): { hostVersion: string; adapterVersion: string; validation: string } {
  const adapter = readPackage(join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter'))
  if (
    !adapter ||
    adapter.manifest.name !== 'pi-mcp-adapter' ||
    typeof adapter.manifest.version !== 'string'
  ) {
    throw new Error(
      `pi-mcp-adapter is not installed in ${agentDir}/npm. Install it with Pi before configuring Chrome DevTools.`
    )
  }
  const extensions = isRecord(adapter.manifest.pi) ? adapter.manifest.pi.extensions : undefined
  if (
    !Array.isArray(extensions) ||
    !extensions.includes('./index.ts') ||
    !statSync(join(adapter.root, 'index.ts')).isFile()
  ) {
    throw new Error('Cannot verify the installed pi-mcp-adapter extension entry.')
  }
  const program = resolveCliCommand('pi', {
    homePath: home,
    pathEnv: env.PATH ?? env.Path,
    platform
  })
  const host = resolvePiPackage(program)
  if (typeof host.manifest.version !== 'string') {
    throw new Error('Pi host version is missing.')
  }
  const requireHost = createRequire(join(host.root, 'package.json'))
  const semver: unknown = requireHost('semver')
  if (!isRecord(semver) || typeof semver.satisfies !== 'function') {
    throw new Error('Cannot verify Pi compatibility: its semver dependency is unavailable.')
  }
  const satisfies = semver.satisfies as (version: string, range: string) => boolean
  if (
    configuredVersion &&
    configuredVersion !== 'latest' &&
    !satisfies(adapter.manifest.version, configuredVersion)
  ) {
    throw new Error(
      'Installed pi-mcp-adapter does not match its registered version; update it through Pi first.'
    )
  }
  const peers = adapter.manifest.peerDependencies
  if (!isRecord(peers)) {
    throw new Error('pi-mcp-adapter compatibility metadata is missing.')
  }
  const aiName = Object.keys(peers).find((name) => name.endsWith('/pi-ai'))
  if (!aiName || typeof peers[aiName] !== 'string') {
    throw new Error('Pi AI compatibility range is unavailable.')
  }
  const ai = resolvePeer(host, aiName)
  if (typeof ai.manifest.version !== 'string' || !satisfies(ai.manifest.version, peers[aiName])) {
    throw new Error(
      `Installed Pi is incompatible with pi-mcp-adapter ${adapter.manifest.version}; update the host or select a compatible adapter.`
    )
  }
  const sampling = readConfig(join(adapter.root, 'sampling-handler.ts'))
  if (sampling?.includes(`${aiName}/compat`)) {
    const exported = isRecord(ai.manifest.exports) ? ai.manifest.exports['./compat'] : undefined
    const entry =
      typeof exported === 'string'
        ? exported
        : isRecord(exported)
          ? (exported.import ?? exported.default)
          : undefined
    if (typeof entry !== 'string' || !statSync(resolve(ai.root, entry)).isFile()) {
      throw new Error(
        'The Pi host does not provide the pi-ai/compat entry required by this adapter.'
      )
    }
  }
  return {
    hostVersion: host.manifest.version,
    adapterVersion: adapter.manifest.version,
    validation: 'installed-metadata; extension-load-not-checked'
  }
}
