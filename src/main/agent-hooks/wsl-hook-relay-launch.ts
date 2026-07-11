// Launch/install plumbing for the guest-resident WSL agent-hook relay:
// bundle resolution on the Windows side, the guest launch/install scripts,
// and the sentinel wait that turns a wsl.exe child's stdio into a
// MultiplexerTransport. Kept separate from the manager so the state machine
// stays readable. See docs/agent-status-over-wsl.md (STA-1515).
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

import type { MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import {
  decodeWslText,
  MAX_STARTUP_BUFFER_BYTES,
  type waitForWslRelaySentinel,
  type WslRelayStartupFailure
} from './wsl-hook-relay-sentinel'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
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
    const appPath = app.getAppPath()
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
  return `$HOME/${WSL_HOOK_RELAY_DIR}/${version}`
}

/** Guest launcher, installed alongside the bundle. The `.version` marker is
 *  written last by the installer, so the check rejects partial installs;
 *  node resolution probes each candidate's version because `sh -c` does not
 *  source interactive profiles (an apt node 12 on PATH must not shadow an
 *  nvm node 20 off PATH). */
export function buildGuestLaunchScript(version: string): string {
  const dir = guestRelayDirExpr(version)
  return [
    '#!/bin/sh',
    `d="${dir}"`,
    `v="$(cat "$d/${WSL_HOOK_RELAY_VERSION_FILE}" 2>/dev/null || true)"`,
    `[ -n "$${WSL_HOOK_RELAY_VERSION_ENV}" ] && [ "$v" = "$${WSL_HOOK_RELAY_VERSION_ENV}" ] || exit ${WSL_HOOK_RELAY_STALE_EXIT_CODE}`,
    'n=""',
    'for c in "$(command -v node 2>/dev/null || true)" "$HOME/.nvm/versions/node"/*/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node"; do',
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
  version: string
): ChildProcessWithoutNullStreams {
  // Why: --exec bypasses the distro's default login shell — a bare `--`
  // routes through it (a fish/nushell chsh could mangle the command) and
  // triggers wsl.exe's `$`-preprocessing of Windows argv. --exec passes argv
  // verbatim (same form as the Codex WSL login spawn), so `$HOME` reaches
  // sh unescaped and expands guest-side.
  const command = `exec sh "${guestRelayDirExpr(version)}/launch.sh"`
  return spawn('wsl.exe', ['-d', distro, '--exec', 'sh', '-c', command], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

/** True when the distro shows in `wsl --list --running`. Listing does NOT
 *  boot anything — unlike `wsl -d`, which starts a stopped distro. The
 *  restart timer must check this so relay recovery never resurrects a VM the
 *  user shut down with `wsl --shutdown`. Fails CLOSED (false) on probe
 *  errors: booting a VM the user shut down is worse than a skipped restart
 *  (the next WSL PTY spawn re-ensures), and a wsl.exe too wedged to list
 *  distros would not have launched the relay anyway. */
export function isWslDistroRunning(distro: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['--list', '--running', '--quiet'],
      // Why: WSL_UTF8=1 forces UTF-8 output; without it wsl.exe emits
      // UTF-16LE that reads as NUL-riddled text.
      { env: { ...process.env, WSL_UTF8: '1' }, timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(false)
          return
        }
        const wanted = distro.trim().toLowerCase()
        const running = decodeWslText(String(stdout))
          .split(/\r?\n/)
          .map((line) => line.trim().toLowerCase())
          .filter(Boolean)
        resolve(running.includes(wanted))
      }
    )
  })
}

export function runWslInstallProcess(
  distro: string,
  script: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Why: --exec skips the default login shell; the script rides stdin so
    // no quoting crosses the wsl.exe boundary at all.
    const child = spawn('wsl.exe', ['-d', distro, '--exec', 'sh', '-s'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    let settled = false
    // Why: a wedged wsl.exe here would otherwise pin the manager's state at
    // 'starting' forever — the one unbounded await on the ensure path.
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        resolve({
          code: null,
          stderr: `${stderr}\ninstall timed out after ${INSTALL_TIMEOUT_MS}ms`
        })
      }
    }, INSTALL_TIMEOUT_MS)
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + decodeWslText(d.toString('utf8'))).slice(-MAX_STARTUP_BUFFER_BYTES)
    })
    child.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(err)
      }
    })
    child.on('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        resolve({ code, stderr })
      }
    })
    child.stdin.on('error', () => {
      // Guest exited before consuming stdin — surfaced via close/code.
    })
    child.stdin.write(script)
    child.stdin.end()
  })
}

const TRANSIENT_RETRY_LIMIT = 2

export type WslRelayLaunchIo = {
  spawnRelay: typeof spawnWslRelayProcess
  waitForSentinel: typeof waitForWslRelaySentinel
  runInstall: typeof runWslInstallProcess
  readBundle: (jsPath: string) => Buffer
  transientRetryDelayMs: number
}

/** Spawn → sentinel → connect, with the guest-install/retry policy: stale or
 *  missing installs get exactly one streamed reinstall, wsl.exe's transient
 *  "Catastrophic failure (E_UNEXPECTED)" gets a bounded retry, a distro
 *  without node >= 18 reports through `onNoNode`. Terminal failures report
 *  through `onFailure`; non-startup errors propagate to the caller. */
export async function launchWslRelayWithInstall(options: {
  distro: string
  env: NodeJS.ProcessEnv
  bundleJsPath: string
  version: string
  io: WslRelayLaunchIo
  isDisposed: () => boolean
  onChild: (child: ChildProcessWithoutNullStreams) => void
  onNoNode: () => void
  onFailure: (message: string) => void
  connect: (transport: MultiplexerTransport, child: ChildProcessWithoutNullStreams) => Promise<void>
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
