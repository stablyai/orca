import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
// Launch/install plumbing for the guest-resident WSL agent-hook relay:
// bundle resolution on the Windows side, the guest launch/install scripts,
// and the sentinel wait that turns a wsl.exe child's stdio into a
// MultiplexerTransport. Kept separate from the manager so the state machine
// stays readable. See docs/agent-status-over-wsl.md (STA-1515).
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '../../shared/child-process/run-process'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

import type { MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import {
  MAX_STARTUP_BUFFER_BYTES,
  type waitForWslRelaySentinel,
  type WslRelayStartupFailure
} from './wsl-hook-relay-sentinel'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { runWslProcess } from '../wsl/wsl-runner'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { listRunningWslDistrosAsync } from '../wsl'
import {
  WSL_HOOK_RELAY_BUNDLE_NAME,
  WSL_HOOK_RELAY_DIR,
  WSL_HOOK_RELAY_INSTANCE_ENV,
  WSL_HOOK_RELAY_RUNTIME_UNAVAILABLE_EXIT_CODE,
  WSL_HOOK_RELAY_STALE_EXIT_CODE,
  WSL_HOOK_RELAY_VERSION_ENV,
  WSL_HOOK_RELAY_VERSION_FILE
} from '../../shared/wsl-hook-relay-contract'

const INSTALL_TIMEOUT_MS = 30_000

export type WslHookRelayBundle = { jsPath: string; version: string }

export function resolveWslHookRelayBundle(): WslHookRelayBundle | null {
  // Mirrors getLocalRelayCandidates in ssh-relay-deploy: env override for
  // tests/dev, then packaged extraResources, then dev out/ paths.
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
    // app not ready in some test contexts — env/resources candidates suffice.
  }
  for (const dir of candidates) {
    const jsPath = join(dir, WSL_HOOK_RELAY_BUNDLE_NAME)
    const versionPath = join(dir, WSL_HOOK_RELAY_VERSION_FILE)
    if (existsSync(jsPath) && existsSync(versionPath)) {
      const version = readFileSync(versionPath, 'utf8').trim()
      // Why: the version lands inside single-quoted guest shell text and in
      // a guest path segment — refuse anything outside the safe alphabet.
      if (/^[A-Za-z0-9+.-]+$/.test(version)) {
        return { jsPath, version }
      }
    }
  }
  return null
}

// Why: the install dir is namespaced by bundle version so concurrent Orca
// instances with different bundles (dev + prod) never reinstall over each
// other; each instance launches exactly the version it shipped.
function guestRelayDirExpr(version: string): string {
  if (!/^[A-Za-z0-9+.-]+$/.test(version)) {
    throw new Error('Invalid WSL hook relay version')
  }
  return `$HOME/${WSL_HOOK_RELAY_DIR}/bun/${version}`
}

/** The host verifies Bun before passing its absolute path as the first argument. */
export function buildGuestLaunchScript(version: string): string {
  const dir = guestRelayDirExpr(version)
  return [
    '#!/bin/sh',
    `d="${dir}"`,
    `v="$(cat "$d/${WSL_HOOK_RELAY_VERSION_FILE}" 2>/dev/null || true)"`,
    `[ -n "$${WSL_HOOK_RELAY_VERSION_ENV}" ] && [ "$v" = "$${WSL_HOOK_RELAY_VERSION_ENV}" ] || exit ${WSL_HOOK_RELAY_STALE_EXIT_CODE}`,
    'runtime="$1"',
    `case "$runtime" in /*) ;; *) exit ${WSL_HOOK_RELAY_RUNTIME_UNAVAILABLE_EXIT_CODE};; esac`,
    `[ -x "$runtime" ] || exit ${WSL_HOOK_RELAY_RUNTIME_UNAVAILABLE_EXIT_CODE}`,
    `exec "$runtime" ${bunOwnedRuntimeArgs('linux').join(' ')} "$d/${WSL_HOOK_RELAY_BUNDLE_NAME}"`,
    ''
  ].join('\n')
}

/** Idempotent install script, piped to `sh -s` over stdin. Heredocs with
 *  quoted delimiters carry the bundle (base64) and launcher verbatim, so no
 *  argv quoting crosses the wsl.exe boundary. Tmp names carry the guest PID
 *  so same-version concurrent installs cannot corrupt each other. */
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
    // Version marker last: a partial install stays "stale" and reinstalls.
    `printf '%s' '${version}' > "$d/${WSL_HOOK_RELAY_VERSION_FILE}"`,
    ''
  ].join('\n')
}

export function spawnWslRelayProcess(
  distro: string,
  env: NodeJS.ProcessEnv,
  version: string,
  executable: string,
  user?: string
): ChildProcessWithoutNullStreams {
  // Why: --exec bypasses the distro's default login shell — a bare `--`
  // routes through it (a fish/nushell chsh could mangle the command) and
  // triggers wsl.exe's `$`-preprocessing of Windows argv. --exec passes argv
  // verbatim (same form as the Codex WSL login spawn), so `$HOME` reaches
  // sh unescaped and expands guest-side.
  const command = `exec sh "${guestRelayDirExpr(version)}/launch.sh" "$1"`
  return spawnProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['sh', '-c', command, 'orca-hook-relay', executable], user),
    env,
    // Why explicit (#16463): the guest path is in `command`, so the Windows cwd
    // only decides whether CreateProcessW succeeds -- and an inherited one is a
    // worktree the user can delete, which kills every later relay launch.
    cwd: resolveWslInteropSpawnCwd()
  })
}

/** True when the distro shows in `wsl --list --running`. Listing does NOT
 *  boot anything — unlike `wsl -d`, which starts a stopped distro. The
 *  restart timer and launch loop check this before each guest operation.
 *  A stopped result is false; probe failures reject instead of using stale
 *  membership: booting a VM the user shut down is worse than a skipped restart
 *  (the next WSL PTY spawn re-ensures), and a wsl.exe too wedged to list
 *  distros would not have launched the relay anyway. */
export function isWslDistroRunning(distro: string): Promise<boolean> {
  const wanted = distro.trim().toLowerCase()
  return listRunningWslDistrosAsync({ requireConfirmed: true }).then((running) =>
    running.some((candidate) => candidate.toLowerCase() === wanted)
  )
}

export async function runWslInstallProcess(
  distro: string,
  script: string,
  // Unused: the install script embeds its own version/paths and reads
  // nothing from the crossed guest environment.
  _env: NodeJS.ProcessEnv,
  user?: string
): Promise<{ code: number | null; stderr: string }> {
  const result = await runWslProcess({
    distro,
    user,
    loginPath: 'none',
    script,
    // Declared because the payload is opaque here: it is POSIX plus a heredoc.
    shell: 'sh',
    timeoutMs: INSTALL_TIMEOUT_MS
    // No maxOutputBytes: the default cap holds the whole stream so the slice
    // below can take the end of it.
  })
  // Tail, not head: the operative error ("mv: Read-only file system") lands
  // after whatever apt and base64 already printed.
  const stderr = result.stderr.slice(-MAX_STARTUP_BUFFER_BYTES)
  return result.timedOut
    ? { code: null, stderr: `${stderr}\ninstall timed out after ${INSTALL_TIMEOUT_MS}ms` }
    : { code: result.code, stderr }
}

const TRANSIENT_RETRY_LIMIT = 2

export type WslRelayLaunchIo = {
  isDistroRunning: typeof isWslDistroRunning
  prepareRuntime: (distro: string, user?: string) => Promise<string>
  spawnRelay: typeof spawnWslRelayProcess
  waitForSentinel: typeof waitForWslRelaySentinel
  runInstall: typeof runWslInstallProcess
  readBundle: (jsPath: string) => Buffer
  transientRetryDelayMs: number
}

/** Spawn → sentinel → connect, with the guest-install/retry policy: stale or
 *  missing installs get exactly one streamed reinstall, wsl.exe's transient
 *  "Catastrophic failure (E_UNEXPECTED)" gets a bounded retry, a distro
 *  with a missing runtime reports through `onRuntimeUnavailable`. Terminal failures report
 *  through `onFailure`; non-startup errors propagate to the caller. */
export async function launchWslRelayWithInstall(options: {
  distro: string
  user?: string
  env: NodeJS.ProcessEnv
  bundleJsPath: string
  version: string
  io: WslRelayLaunchIo
  isDisposed: () => boolean
  onChild: (child: ChildProcessWithoutNullStreams) => void
  onRuntimeUnavailable: () => void
  onFailure: (message: string) => void
  connect: (transport: MultiplexerTransport, child: ChildProcessWithoutNullStreams) => Promise<void>
}): Promise<void> {
  const { distro, env, bundleJsPath, version, io } = options
  if (options.isDisposed()) {
    return
  }
  const requireRunning = async (): Promise<boolean> => {
    if (options.isDisposed()) {
      return false
    }
    const running = await io.isDistroRunning(distro)
    if (options.isDisposed()) {
      return false
    }
    if (!running) {
      options.onFailure(`distro '${distro}' is not running; relay setup deferred`)
    }
    return running
  }
  const executable = await io.prepareRuntime(distro, ...(options.user ? [options.user] : []))
  let installTried = false
  let transientRetries = 0
  for (;;) {
    if (!(await requireRunning())) {
      return
    }
    const child = io.spawnRelay(
      distro,
      env,
      version,
      executable,
      ...(options.user ? [options.user] : [])
    )
    options.onChild(child)
    try {
      const transport = await io.waitForSentinel(child)
      await options.connect(transport, child)
      return
    } catch (err) {
      // Why before the failure triage: once disposed, the guest install and retries below are
      // work the caller no longer wants — the "failure" is usually our own teardown kill.
      if (options.isDisposed()) {
        return
      }
      const failure = (err as { startup?: WslRelayStartupFailure }).startup
      if (!failure) {
        throw err
      }
      if (failure.code === WSL_HOOK_RELAY_RUNTIME_UNAVAILABLE_EXIT_CODE) {
        options.onRuntimeUnavailable()
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
        if (!(await requireRunning())) {
          return
        }
        const script = buildGuestInstallScript(io.readBundle(bundleJsPath), version)
        const result = await io.runInstall(
          distro,
          script,
          env,
          ...(options.user ? [options.user] : [])
        )
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

/** Env for the relay's wsl.exe spawn: the live hook coordinates, the
 *  host-expected bundle version, and the stable instance key, all crossed
 *  via WSLENV. WSL_UTF8 keeps wsl.exe's own error text (e.g. "Catastrophic
 *  failure") UTF-8 so stderr matching and breadcrumbs stay readable. */
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
  // Why: the relay derives its own guest endpoint path; a /p-translated
  // Windows endpoint here would only add WSLENV noise.
  delete env.ORCA_AGENT_HOOK_ENDPOINT
  addOrcaWslInteropEnv(env as Record<string, string>)
  return env
}
