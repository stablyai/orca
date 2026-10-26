import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { withWslGuestLauncherRevision } from '../wsl/wsl-guest-launcher-revision'
import { orcadPosixNodeRuntimeGlobs } from '../managed-server/install/orcad-node-runtime-globs'

import type { MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import {
  MAX_STARTUP_BUFFER_BYTES,
  type waitForWslRelaySentinel,
  type WslRelayStartupFailure
} from './wsl-hook-relay-sentinel'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { runWslProcess } from '../wsl/wsl-runner'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import {
  WSL_HOOK_RELAY_BUNDLE_NAME,
  WSL_HOOK_RELAY_DIR,
  WSL_HOOK_RELAY_INSTANCE_ENV,
  WSL_HOOK_RELAY_NO_NODE_EXIT_CODE,
  WSL_HOOK_RELAY_STALE_EXIT_CODE,
  WSL_HOOK_RELAY_VERSION_ENV,
  WSL_HOOK_RELAY_VERSION_FILE
} from '../../shared/wsl-hook-relay-contract'

const INSTALL_TIMEOUT_MS = 30_000

export type WslHookRelayBundle = { jsPath: string; version: string }

export function resolveWslHookRelayBundle(): WslHookRelayBundle | null {
  for (const dir of relayBundleCandidates('wsl')) {
    const jsPath = join(dir, WSL_HOOK_RELAY_BUNDLE_NAME)
    const versionPath = join(dir, WSL_HOOK_RELAY_VERSION_FILE)
    if (existsSync(jsPath) && existsSync(versionPath)) {
      const version = readFileSync(versionPath, 'utf8').trim()
      // Versions become shell literals and path segments; accept only a safe alphabet.
      if (/^[A-Za-z0-9+.-]+$/.test(version)) {
        return { jsPath, version: withWslGuestLauncherRevision(version, buildGuestLaunchScript) }
      }
    }
  }
  return null
}

// Versioned directories keep parallel Orca builds from overwriting each other.
function guestRelayDirExpr(version: string): string {
  return `$HOME/${WSL_HOOK_RELAY_DIR}/${version}`
}

/** Probe candidate Node versions: noninteractive sh may miss a newer nvm installation. */
export function buildGuestLaunchScript(version: string): string {
  const dir = guestRelayDirExpr(version)
  // A WSL host distro may have no system node but usually has orcad's pinned runtime.
  const [orcadRuntime, orcadMachineRuntimes] = orcadPosixNodeRuntimeGlobs()
  return [
    '#!/bin/sh',
    `d="${dir}"`,
    `v="$(cat "$d/${WSL_HOOK_RELAY_VERSION_FILE}" 2>/dev/null || true)"`,
    `[ -n "$${WSL_HOOK_RELAY_VERSION_ENV}" ] && [ "$v" = "$${WSL_HOOK_RELAY_VERSION_ENV}" ] || exit ${WSL_HOOK_RELAY_STALE_EXIT_CODE}`,
    'n=""',
    `for c in "$(command -v node 2>/dev/null || true)" "$HOME/.nvm/versions/node"/*/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node" ${orcadRuntime} ${orcadMachineRuntimes}; do`,
    '  [ -n "$c" ] && [ -x "$c" ] || continue',
    `  if "$c" -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' 2>/dev/null; then`,
    '    n="$c"',
    '    break',
    '  fi',
    'done',
    `[ -n "$n" ] || exit ${WSL_HOOK_RELAY_NO_NODE_EXIT_CODE}`,
    `exec "$n" "$d/${WSL_HOOK_RELAY_BUNDLE_NAME}"`,
    ''
  ].join('\n')
}

/** Quoted heredocs avoid cross-boundary argv quoting; PID temp names isolate concurrent installs. */
export function buildGuestInstallScript(bundleJs: Buffer, version: string): string {
  const b64 = bundleJs.toString('base64').replace(/(.{1,120})/g, '$1\n')
  return [
    'set -e',
    'umask 077',
    `d="${guestRelayDirExpr(version)}"`,
    'mkdir -p "$d"',
    `base64 -d > "$d/bundle.$$.tmp" << 'ORCA_EOF_BUNDLE'`,
    b64.trimEnd(),
    'ORCA_EOF_BUNDLE',
    `mv "$d/bundle.$$.tmp" "$d/${WSL_HOOK_RELAY_BUNDLE_NAME}"`,
    `cat > "$d/launch.$$.tmp" << 'ORCA_EOF_LAUNCH'`,
    buildGuestLaunchScript(version).trimEnd(),
    'ORCA_EOF_LAUNCH',
    'mv "$d/launch.$$.tmp" "$d/launch.sh"',
    'chmod 700 "$d/launch.sh"',
    // Publish the version marker after the bundle and launcher are ready.
    `printf '%s' '${version}' > "$d/${WSL_HOOK_RELAY_VERSION_FILE}"`,
    ''
  ].join('\n')
}

export function spawnWslRelayProcess(
  distro: string,
  env: NodeJS.ProcessEnv,
  version: string
): PipedChildProcess {
  // --exec bypasses login-shell rewriting and passes $HOME verbatim for guest-side expansion.
  const command = `exec sh "${guestRelayDirExpr(version)}/launch.sh"`
  return spawnProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['sh', '-c', command]),
    env,
    stdio: 'pipe',
    // Use a stable Windows cwd so deleting the current worktree cannot break later relay launches.
    cwd: resolveWslInteropSpawnCwd()
  })
}

export async function runWslInstallProcess(
  distro: string,
  script: string,
  // Guest paths and version are embedded in the script rather than crossed through env.
  _env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string }> {
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script,
    shell: 'sh',
    timeoutMs: INSTALL_TIMEOUT_MS
  })
  // Keep the tail, where install failures follow startup output.
  const stderr = result.stderr.slice(-MAX_STARTUP_BUFFER_BYTES)
  return result.timedOut
    ? { code: null, stderr: `${stderr}\ninstall timed out after ${INSTALL_TIMEOUT_MS}ms` }
    : { code: result.code, stderr }
}

const TRANSIENT_RETRY_LIMIT = 2

export type WslRelayLaunchIo = {
  spawnRelay: typeof spawnWslRelayProcess
  waitForSentinel: typeof waitForWslRelaySentinel
  runInstall: typeof runWslInstallProcess
  readBundle: (jsPath: string) => Buffer
  transientRetryDelayMs: number
}

/** Reinstall once on startup failure, retry transient WSL failures, and report missing Node separately. */
export async function launchWslRelayWithInstall(options: {
  distro: string
  env: NodeJS.ProcessEnv
  bundleJsPath: string
  version: string
  io: WslRelayLaunchIo
  isDisposed: () => boolean
  onChild: (child: PipedChildProcess) => void
  onNoNode: () => void
  onFailure: (message: string) => void
  connect: (transport: MultiplexerTransport, child: PipedChildProcess) => Promise<void>
}): Promise<void> {
  const { distro, env, bundleJsPath, version, io } = options
  let installTried = false
  let transientRetries = 0
  for (;;) {
    if (options.isDisposed()) {
      return
    }
    const child = io.spawnRelay(distro, env, version)
    options.onChild(child)
    try {
      const transport = await io.waitForSentinel(child)
      await options.connect(transport, child)
      return
    } catch (err) {
      // Teardown failures must not trigger unwanted guest installs or retries.
      if (options.isDisposed()) {
        return
      }
      const failure = (err as { startup?: WslRelayStartupFailure }).startup
      if (!failure) {
        throw err
      }
      if (failure.code === WSL_HOOK_RELAY_NO_NODE_EXIT_CODE) {
        options.onNoNode()
        return
      }
      if (
        /catastrophic failure/i.test(failure.stderr) &&
        transientRetries < TRANSIENT_RETRY_LIMIT
      ) {
        transientRetries++
        await new Promise((resolve) => setTimeout(resolve, io.transientRetryDelayMs))
        continue
      }
      if (!installTried) {
        installTried = true
        const script = buildGuestInstallScript(io.readBundle(bundleJsPath), version)
        const result = await io.runInstall(distro, script, env)
        if (result.code === 0) {
          continue
        }
        options.onFailure(
          `guest install failed (code ${result.code ?? 'unknown'}): ${result.stderr.trim()}`
        )
        return
      }
      options.onFailure(formatWslRelayFailure(failure))
      return
    }
  }
}

export function formatWslRelayFailure(failure: WslRelayStartupFailure): string {
  const detail = failure.stderr.trim()
  return `startup failed (${failure.kind}, code ${failure.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`
}

/** WSLENV carries coordinates and instance/version identity; WSL_UTF8 keeps failure text readable. */
export function buildWslRelaySpawnEnv(
  coords: Record<string, string>,
  bundleVersion: string,
  instanceKey: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WSL_UTF8: '1',
    ORCA_AGENT_HOOK_PORT: coords.ORCA_AGENT_HOOK_PORT,
    ORCA_AGENT_HOOK_TOKEN: coords.ORCA_AGENT_HOOK_TOKEN,
    ORCA_AGENT_HOOK_ENV: coords.ORCA_AGENT_HOOK_ENV,
    ORCA_AGENT_HOOK_VERSION: coords.ORCA_AGENT_HOOK_VERSION,
    [WSL_HOOK_RELAY_VERSION_ENV]: bundleVersion,
    [WSL_HOOK_RELAY_INSTANCE_ENV]: instanceKey
  }
  // The guest derives its endpoint path; do not translate the Windows endpoint through WSLENV.
  delete env.ORCA_AGENT_HOOK_ENDPOINT
  addOrcaWslInteropEnv(env as Record<string, string>)
  return env
}
