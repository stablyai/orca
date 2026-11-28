import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { relayBundleCandidates } from '../../../wsl/execution/relay-bundle-paths'
import { withWslGuestLauncherRevision } from '../../../wsl/execution/wsl-guest-launcher-revision'
import { orcadPosixNodeRuntimeGlobs } from '../../../managed-server/install/orcad-node-runtime-globs'
import {
  WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME,
  WSL_BROWSER_NETWORK_RELAY_NO_NODE_EXIT_CODE,
  WSL_BROWSER_NETWORK_RELAY_SENTINEL,
  WSL_BROWSER_NETWORK_RELAY_STALE_EXIT_CODE,
  WSL_BROWSER_NETWORK_RELAY_VERSION_FILE
} from '../../../../shared/browser/network/tunnels/wsl-browser-network-relay-contract'

const STARTUP_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 30_000
const MAX_PRELUDE_BYTES = 64 * 1024
const RELAY_SENTINEL = Buffer.from(WSL_BROWSER_NETWORK_RELAY_SENTINEL)

/** A relay process on the execution host whose stdio carries tunnel frames. */
export type BrowserNetworkRelayChild = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(): void
}

/** A POSIX host that can run `/bin/sh -c <command>` with piped stdio. */
export type BrowserNetworkRelayHost = {
  /** The relay's versioned directories live here, relative to the host's $HOME. */
  homeDir: string
  run(command: string): Promise<BrowserNetworkRelayChild>
}

type BrowserNetworkRelayBundle = { jsPath: string; version: string }

/** One relay bundle serves WSL distros and POSIX SSH hosts; it needs only Node 18+. */
export async function resolveBrowserNetworkRelayBundle(): Promise<BrowserNetworkRelayBundle | null> {
  for (const dir of relayBundleCandidates('wsl')) {
    const version = await readFile(join(dir, WSL_BROWSER_NETWORK_RELAY_VERSION_FILE), 'utf8').then(
      (text) => text.trim(),
      () => null
    )
    if (version && /^[A-Za-z0-9+.-]+$/.test(version)) {
      return {
        jsPath: join(dir, WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME),
        version: withWslGuestLauncherRevision(version, buildBrowserNetworkRelayLaunchScript)
      }
    }
  }
  return null
}

function relayDir(homeDir: string, version: string): string {
  if (!/^[A-Za-z0-9+.-]+$/.test(version) || !/^[A-Za-z0-9._/-]+$/.test(homeDir)) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  return `$HOME/${homeDir}/${version}`
}

/** launch.sh finds its own directory, so one script serves every host's relay home. */
export function buildBrowserNetworkRelayLaunchScript(version: string): string {
  // A host may have no system node but usually has orcad's pinned runtime.
  const [orcadRuntime, orcadMachineRuntimes] = orcadPosixNodeRuntimeGlobs()
  return [
    '#!/bin/sh',
    'd="${0%/*}"',
    `v="$(cat "$d/${WSL_BROWSER_NETWORK_RELAY_VERSION_FILE}" 2>/dev/null || true)"`,
    `[ "$v" = '${version}' ] || exit ${WSL_BROWSER_NETWORK_RELAY_STALE_EXIT_CODE}`,
    'n=""',
    `for c in "$(command -v node 2>/dev/null || true)" "$HOME/.nvm/versions/node"/*/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node" ${orcadRuntime} ${orcadMachineRuntimes}; do`,
    '  [ -n "$c" ] && [ -x "$c" ] || continue',
    `  if "$c" -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' 2>/dev/null; then`,
    '    n="$c"',
    '    break',
    '  fi',
    'done',
    `[ -n "$n" ] || exit ${WSL_BROWSER_NETWORK_RELAY_NO_NODE_EXIT_CODE}`,
    `exec "$n" "$d/${WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME}"`,
    ''
  ].join('\n')
}

export function buildBrowserNetworkRelayInstallScript(
  homeDir: string,
  bundle: Buffer,
  version: string
): string {
  const encoded = bundle
    .toString('base64')
    .replace(/(.{1,120})/g, '$1\n')
    .trimEnd()
  return [
    'set -e',
    'umask 077',
    `d="${relayDir(homeDir, version)}"`,
    'mkdir -p "$d"',
    // macOS 12 and older only decode with -D; a rejected -d reads nothing, leaving the input for it.
    '{ base64 -d 2>/dev/null || base64 -D; } > "$d/bundle.$$.tmp" << \'ORCA_EOF_BUNDLE\'',
    encoded,
    'ORCA_EOF_BUNDLE',
    `mv "$d/bundle.$$.tmp" "$d/${WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME}"`,
    'cat > "$d/launch.$$.tmp" << \'ORCA_EOF_LAUNCH\'',
    buildBrowserNetworkRelayLaunchScript(version).trimEnd(),
    'ORCA_EOF_LAUNCH',
    'mv "$d/launch.$$.tmp" "$d/launch.sh"',
    'chmod 700 "$d/launch.sh"',
    `printf '%s' '${version}' > "$d/${WSL_BROWSER_NETWORK_RELAY_VERSION_FILE}"`,
    ''
  ].join('\n')
}

/** Starts the host's relay, installing this build's bundle once when it is missing or stale. */
export async function launchBrowserNetworkRelay(
  host: BrowserNetworkRelayHost,
  signal: AbortSignal
): Promise<BrowserNetworkRelayChild> {
  const bundle = await resolveBrowserNetworkRelayBundle()
  if (!bundle || signal.aborted) {
    throw new Error('browser_tunnel_execution_host_unavailable')
  }
  let installTried = false
  for (;;) {
    const attempt = await startRelay(host, bundle.version, signal)
    if (attempt.child) {
      return attempt.child
    }
    if (signal.aborted || attempt.code === WSL_BROWSER_NETWORK_RELAY_NO_NODE_EXIT_CODE) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
    if (installTried) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
    installTried = true
    const bytes = await readFile(bundle.jsPath).catch(() => null)
    if (
      !bytes ||
      !(await installRelay(
        host,
        buildBrowserNetworkRelayInstallScript(host.homeDir, bytes, bundle.version),
        signal
      ))
    ) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
  }
}

async function startRelay(
  host: BrowserNetworkRelayHost,
  version: string,
  signal: AbortSignal
): Promise<{ child?: BrowserNetworkRelayChild; code?: number | null }> {
  const child = await runOnHost(host, `exec sh "${relayDir(host.homeDir, version)}/launch.sh"`)
  if (!child) {
    return { code: null }
  }
  return new Promise((resolve) => {
    let settled = false
    let prelude = Buffer.alloc(0)
    const settle = (result: { child?: BrowserNetworkRelayChild; code?: number | null }) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      child.stdout.off('data', onStdout)
      if (result.child) {
        child.stdout.pause()
      } else {
        // ssh2 holds a channel's close until its stdout is read to the end.
        child.stdout.resume()
      }
      resolve(result)
    }
    const abort = (): void => {
      child.kill()
      settle({ code: null })
    }
    // Login profiles may print before the relay starts; frames begin right after the sentinel.
    const onStdout = (bytes: Buffer): void => {
      prelude = Buffer.concat([prelude, bytes])
      const at = prelude.indexOf(RELAY_SENTINEL)
      if (at !== -1) {
        const frames = prelude.subarray(at + RELAY_SENTINEL.length)
        settle({ child })
        if (frames.length > 0) {
          child.stdout.unshift(frames)
        }
      } else if (prelude.length > MAX_PRELUDE_BYTES) {
        abort()
      }
    }
    const timeout = setTimeout(abort, STARTUP_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    child.stderr.resume()
    child.stdout.on('data', onStdout)
    child.on('error', () => settle({ code: null }))
    child.on('close', (code) => settle({ code }))
    if (signal.aborted) {
      abort()
    }
  })
}

async function installRelay(
  host: BrowserNetworkRelayHost,
  script: string,
  signal: AbortSignal
): Promise<boolean> {
  const child = await runOnHost(host, 'exec sh -s')
  if (!child) {
    return false
  }
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
    child.stdin.end(script)
    if (signal.aborted) {
      abort()
    }
  })
}

async function runOnHost(
  host: BrowserNetworkRelayHost,
  command: string
): Promise<BrowserNetworkRelayChild | null> {
  try {
    return await host.run(command)
  } catch {
    return null
  }
}
