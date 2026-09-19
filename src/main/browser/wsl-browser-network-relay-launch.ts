import { spawnProcess } from '../../shared/child-process/run-process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import {
  WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME,
  WSL_BROWSER_NETWORK_RELAY_BUN_REQUIRED_FILE,
  WSL_BROWSER_NETWORK_RELAY_DIR,
  WSL_BROWSER_NETWORK_RELAY_NO_NODE_EXIT_CODE,
  WSL_BROWSER_NETWORK_RELAY_SENTINEL,
  WSL_BROWSER_NETWORK_RELAY_STALE_EXIT_CODE,
  WSL_BROWSER_NETWORK_RELAY_VERSION_FILE
} from '../../shared/wsl-browser-network-relay-contract'

const STARTUP_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 30_000
const MAX_STDERR_BYTES = 32 * 1024

/**
 * The relay child. `spawnProcess` always pipes all three streams, so the non-null
 * shape is a fact of the chokepoint rather than an assumption about this call.
 */
export type WslBrowserNetworkRelayChild = ReturnType<typeof spawnProcess> & {
  stdin: NonNullable<ReturnType<typeof spawnProcess>['stdin']>
  stdout: NonNullable<ReturnType<typeof spawnProcess>['stdout']>
  stderr: NonNullable<ReturnType<typeof spawnProcess>['stderr']>
}

type WslBrowserNetworkRelayBundle = {
  jsPath: string
  version: string
  bunRuntimePaths?: Record<string, string>
  /** Release bundles set this so a missing Bun never falls back to distro Node. */
  requiresBundledBun?: boolean
}

export function resolveWslBrowserNetworkRelayBundle(): WslBrowserNetworkRelayBundle | null {
  const candidates: string[] = []
  if (process.env.ORCA_RELAY_PATH) {
    candidates.push(join(process.env.ORCA_RELAY_PATH, 'wsl'))
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'relay', 'wsl'))
    candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'out', 'relay', 'wsl'))
  }
  try {
    const appPath = getAppEnvironment().getAppPath()
    candidates.push(join(appPath, 'resources', 'relay', 'wsl'))
    candidates.push(join(appPath, 'out', 'relay', 'wsl'))
  } catch {
    // Tests, early startup and plain-Node hosts have no app path — env/resources candidates suffice.
  }
  for (const dir of candidates) {
    const jsPath = join(dir, WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME)
    const versionPath = join(dir, WSL_BROWSER_NETWORK_RELAY_VERSION_FILE)
    if (!existsSync(jsPath) || !existsSync(versionPath)) {
      continue
    }
    const version = readFileSync(versionPath, 'utf8').trim()
    if (/^[A-Za-z0-9+.-]+$/.test(version)) {
      const bunRuntimePaths: Record<string, string> = {}
      for (const key of ['x64-glibc', 'x64-musl', 'arm64-glibc', 'arm64-musl']) {
        const runtimePath = join(dir, `bun-runtime-linux-${key}`)
        if (existsSync(runtimePath)) {
          bunRuntimePaths[key] = runtimePath
        }
      }
      return {
        jsPath,
        version,
        ...(existsSync(join(dir, WSL_BROWSER_NETWORK_RELAY_BUN_REQUIRED_FILE))
          ? { requiresBundledBun: true }
          : {}),
        ...(Object.keys(bunRuntimePaths).length > 0 ? { bunRuntimePaths } : {})
      }
    }
  }
  return null
}

function guestRelayDir(version: string): string {
  if (!/^[A-Za-z0-9+.-]+$/.test(version)) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  return `$HOME/${WSL_BROWSER_NETWORK_RELAY_DIR}/${version}`
}

export function buildWslBrowserNetworkGuestLaunchScript(
  version: string,
  options: { requiresBundledBun?: boolean } = {}
): string {
  const dir = guestRelayDir(version)
  return [
    '#!/bin/sh',
    `d="${dir}"`,
    `v="$(cat "$d/${WSL_BROWSER_NETWORK_RELAY_VERSION_FILE}" 2>/dev/null || true)"`,
    `[ "$v" = '${version}' ] || exit ${WSL_BROWSER_NETWORK_RELAY_STALE_EXIT_CODE}`,
    'r=""',
    'orca_arch="$(uname -m 2>/dev/null || true)"',
    'case "$orca_arch" in x86_64|amd64) orca_arch=x64;; aarch64|arm64) orca_arch=arm64;; *) orca_arch="";; esac',
    'orca_libc="glibc"',
    'orca_getconf="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"',
    'case "$orca_getconf" in *glibc*|*GLIBC*) orca_libc=glibc;; *) if ldd --version 2>&1 | grep -qi musl; then orca_libc=musl; fi;; esac',
    'for c in "$d/bun-runtime-${orca_arch}-${orca_libc}" "$(command -v bun 2>/dev/null || true)" "$HOME/.bun/bin/bun"; do',
    '  [ -n "$c" ] && [ -x "$c" ] || continue',
    `  if [ "$("$c" --version 2>/dev/null || true)" = "${ORCAD_BUN_VERSION}" ]; then`,
    '    r="$c"',
    '    break',
    '  fi',
    'done',
    `[ -n "$r" ] && exec "$r" "$d/${WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME}"`,
    ...(options.requiresBundledBun
      ? [`exit ${WSL_BROWSER_NETWORK_RELAY_NO_NODE_EXIT_CODE}`]
      : [
          'n=""',
          'for c in "$(command -v node 2>/dev/null || true)" "$HOME/.nvm/versions/node"/*/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node"; do',
          '  [ -n "$c" ] && [ -x "$c" ] || continue',
          `  if "$c" -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' 2>/dev/null; then`,
          '    n="$c"',
          '    break',
          '  fi',
          'done',
          `[ -n "$n" ] || exit ${WSL_BROWSER_NETWORK_RELAY_NO_NODE_EXIT_CODE}`,
          `exec "$n" "$d/${WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME}"`
        ]),
    ''
  ].join('\n')
}

export function buildWslBrowserNetworkGuestInstallScript(
  bundle: Buffer,
  version: string,
  bunRuntimes: Record<string, Buffer> = {},
  options: { requiresBundledBun?: boolean } = {}
): string {
  const encoded = bundle
    .toString('base64')
    .replace(/(.{1,120})/g, '$1\n')
    .trimEnd()
  const runtimePayloads = Object.entries(bunRuntimes).flatMap(([key, runtime]) => {
    const safeKey = key.replace(/[^A-Za-z0-9_-]/g, '')
    if (!safeKey) {
      throw new Error(`Invalid Bun runtime payload key: ${key}`)
    }
    const marker = `ORCA_EOF_BUN_${safeKey}`
    return [
      `base64 -d > "$d/bun-runtime-${safeKey}.$$.tmp" << '${marker}'`,
      runtime
        .toString('base64')
        .replace(/(.{1,120})/g, '$1\n')
        .trimEnd(),
      marker,
      `mv "$d/bun-runtime-${safeKey}.$$.tmp" "$d/bun-runtime-${safeKey}"`,
      `chmod 700 "$d/bun-runtime-${safeKey}"`
    ]
  })
  return [
    'set -e',
    'umask 077',
    `d="${guestRelayDir(version)}"`,
    'mkdir -p "$d"',
    'base64 -d > "$d/bundle.$$.tmp" << \'ORCA_EOF_BUNDLE\'',
    encoded,
    'ORCA_EOF_BUNDLE',
    `mv "$d/bundle.$$.tmp" "$d/${WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME}"`,
    ...runtimePayloads,
    'cat > "$d/launch.$$.tmp" << \'ORCA_EOF_LAUNCH\'',
    buildWslBrowserNetworkGuestLaunchScript(version, options).trimEnd(),
    'ORCA_EOF_LAUNCH',
    'mv "$d/launch.$$.tmp" "$d/launch.sh"',
    'chmod 700 "$d/launch.sh"',
    `printf '%s' '${version}' > "$d/${WSL_BROWSER_NETWORK_RELAY_VERSION_FILE}"`,
    ''
  ].join('\n')
}

export async function launchWslBrowserNetworkRelay(
  distro: string,
  signal: AbortSignal
): Promise<WslBrowserNetworkRelayChild> {
  const bundle = resolveWslBrowserNetworkRelayBundle()
  if (!bundle || signal.aborted) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  let installTried = false
  for (;;) {
    const attempt = await startWslBrowserNetworkRelay(distro, bundle.version, signal)
    if (attempt.child) {
      return attempt.child
    }
    if (signal.aborted) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
    // A strict release bundle gets one streamed repair when its guest Bun
    // copy is damaged. Legacy bundles keep the old immediate Node-floor error.
    if (
      attempt.code === WSL_BROWSER_NETWORK_RELAY_NO_NODE_EXIT_CODE &&
      !bundle.requiresBundledBun
    ) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
    if (installTried) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
    installTried = true
    const installed = await installWslBrowserNetworkRelay(distro, bundle, signal)
    if (!installed) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
  }
}

async function startWslBrowserNetworkRelay(
  distro: string,
  version: string,
  signal: AbortSignal
): Promise<{ child?: WslBrowserNetworkRelayChild; code?: number | null }> {
  const command = `exec sh "${guestRelayDir(version)}/launch.sh"`
  const child = spawnProcess({
    program: 'wsl.exe',
    args: ['-d', distro, '--exec', 'sh', '-c', command],
    env: { ...process.env, WSL_UTF8: '1' }
  }) as WslBrowserNetworkRelayChild
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    const settle = (result: { child?: WslBrowserNetworkRelayChild; code?: number | null }) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = (): void => {
      child.kill()
      settle({ code: null })
    }
    const timeout = setTimeout(abort, STARTUP_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    child.stderr.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString('utf8')).slice(-MAX_STDERR_BYTES)
      if (stderr.includes(WSL_BROWSER_NETWORK_RELAY_SENTINEL)) {
        settle({ child })
      }
    })
    child.on('error', () => settle({ code: null }))
    child.on('close', (code) => settle({ code }))
  })
}

function installWslBrowserNetworkRelay(
  distro: string,
  bundle: WslBrowserNetworkRelayBundle,
  signal: AbortSignal
): Promise<boolean> {
  const child = spawnProcess({
    program: 'wsl.exe',
    args: ['-d', distro, '--exec', 'sh', '-s'],
    env: { ...process.env, WSL_UTF8: '1' }
  }) as WslBrowserNetworkRelayChild
  return new Promise((resolve) => {
    let settled = false
    const settle = (installed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      resolve(installed)
    }
    const abort = (): void => {
      child.kill()
      settle(false)
    }
    const timeout = setTimeout(abort, INSTALL_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    child.stderr.resume()
    child.stdout.resume()
    child.on('error', () => settle(false))
    child.on('close', (code) => settle(code === 0))
    child.stdin.on('error', () => {})
    child.stdin.end(
      buildWslBrowserNetworkGuestInstallScript(
        readFileSync(bundle.jsPath),
        bundle.version,
        Object.fromEntries(
          Object.entries(bundle.bunRuntimePaths ?? {}).map(([key, path]) => [
            key,
            readFileSync(path)
          ])
        ),
        { requiresBundledBun: bundle.requiresBundledBun }
      )
    )
  })
}
