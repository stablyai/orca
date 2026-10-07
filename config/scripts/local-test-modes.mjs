#!/usr/bin/env node

// Launches Orca in a chosen local host topology so features (native chat, source
// control, terminals, …) can be exercised across execution hosts on one machine:
//
//   local              a single desktop app (local host only)
//   remote             a headless `orca serve` runtime + an auto-paired web client
//   local-remote       a desktop app + a runtime server, pre-seeded into the app
//   local-ssh          a desktop app + prep for adding a localhost SSH host
//   local-remote-ssh   desktop + runtime server + SSH prep
//
// Each host gets its own isolated userData profile so instances never collide.
// It composes the existing building blocks (run-electron-vite-dev.mjs,
// serve-headless-fresh-profile-pairing.mjs, orca-dev.mjs) rather than reinventing
// them. See docs/local-multi-host-test-modes.md.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const scriptDir = import.meta.dirname
const repoRoot = path.resolve(scriptDir, '..', '..')
const orcaDevScript = path.join(scriptDir, 'orca-dev.mjs')
const serveScript = path.join(scriptDir, 'serve-headless-fresh-profile-pairing.mjs')
const runDevScript = path.join(scriptDir, 'run-electron-vite-dev.mjs')
const ensureRuntimeScript = path.join(scriptDir, 'ensure-native-runtime.mjs')

/** Each mode is a set of host "arms". `seedRemote` wires the serve arm's pairing
 *  code into the desktop arm's saved-server list so it appears in the app. */
const MODES = {
  local: { arms: ['desktop'], seedRemote: false },
  remote: { arms: ['serve', 'web'], seedRemote: false },
  'local-remote': { arms: ['serve', 'desktop'], seedRemote: true },
  'local-ssh': { arms: ['desktop', 'ssh'], seedRemote: false },
  'local-remote-ssh': { arms: ['serve', 'desktop', 'ssh'], seedRemote: true }
}

// Avoid 6768 (packaged serve default) and 6769 (pnpm dev). First serve arm → 6780.
const SERVE_PORT_BASE = 6780
const REMOTE_ENV_NAME = 'mode-remote'
const SERVE_READY_TIMEOUT_MS = 180_000

const cli = parseArgs(process.argv.slice(2))
if (cli.help || !cli.mode) {
  printHelp()
  process.exit(cli.mode ? 0 : cli.help ? 0 : 2)
}
const mode = MODES[cli.mode]
if (!mode) {
  console.error(
    `local-test-modes: unknown mode "${cli.mode}". Known: ${Object.keys(MODES).join(', ')}`
  )
  process.exit(2)
}

const runId = Math.random().toString(36).slice(2, 8)
// Why: macOS binds the daemon at <profile>/daemon/daemon-v24.sock and the sun_path
// limit is ~104 bytes; the OS temp dir (/var/folders/…) already blows past it, so
// anchor profiles at a short path. Windows uses named pipes and has no such limit.
const baseDir = path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orca-modes', runId)

const children = []
let tornDown = false

async function main() {
  console.error(`[modes] mode=${cli.mode} arms=${mode.arms.join('+')} base=${baseDir}`)
  if (cli.dryRun) {
    printPlan()
    return
  }

  mkdirSync(baseDir, { recursive: true })
  installSignalHandlers()

  if (!cli.noBuild) {
    ensurePrerequisites(mode.arms)
  }

  let pairing = null
  // Serve first: the desktop-seed and web arms both consume its pairing code.
  if (mode.arms.includes('serve')) {
    pairing = await startServeArm(path.join(baseDir, 'server'), SERVE_PORT_BASE)
  }

  if (mode.seedRemote && pairing?.pairingUrl) {
    seedDesktopRuntimeEnvironment(path.join(baseDir, 'desk'), pairing.pairingUrl)
  }

  if (mode.arms.includes('web')) {
    openWebClient(pairing)
  }

  if (mode.arms.includes('ssh')) {
    prepareSshArm()
  }

  if (mode.arms.includes('desktop')) {
    startDesktopArm(path.join(baseDir, 'desk'))
  }

  printNextSteps(pairing)

  if (children.length === 0) {
    // A web-only remote mode with no long-lived child we own (browser detaches):
    // nothing to wait on, so exit cleanly after printing the URL.
    return
  }
  // Keep the orchestrator alive so Ctrl+C tears down every arm together.
  await new Promise(() => {})
}

// ── Arms ────────────────────────────────────────────────────────────────────

/** Runs the headless serve wrapper against an isolated profile and resolves once
 *  it prints its pairing URL. Returns the parsed pairing/web/endpoint strings. */
function startServeArm(profileDir, port) {
  mkdirSync(profileDir, { recursive: true })
  const args = [serveScript, '--port', String(port), '--pairing-address', '127.0.0.1']
  console.error(`[modes] serve → port ${port}, profile ${profileDir}`)
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: childEnv({ ORCA_HEADLESS_PAIRING_PROFILE_DIR: profileDir }),
    stdio: ['inherit', 'pipe', 'inherit']
  })
  track(child, 'serve')

  const result = { child, pairingUrl: null, webClientUrl: null, endpoint: null, port }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`serve did not become ready within ${SERVE_READY_TIMEOUT_MS / 1000}s`))
    }, SERVE_READY_TIMEOUT_MS)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      process.stdout.write(`[serve] ${line}\n`)
      const pairing = matchAfter(line, 'Pairing URL:')
      const web = matchAfter(line, 'Web client URL:')
      const ready = matchAfter(line, 'Orca server ready:')
      if (web) {
        result.webClientUrl = web
      }
      if (ready) {
        result.endpoint = ready
      }
      if (pairing) {
        result.pairingUrl = pairing
        clearTimeout(timer)
        resolve(result)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (!result.pairingUrl) {
        reject(new Error(`serve exited (code ${code ?? 'null'}) before printing a pairing URL`))
      }
    })
  })
}

function startDesktopArm(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  console.error(`[modes] desktop → profile ${profileDir}`)
  const child = spawn(process.execPath, [runDevScript], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: childEnv({ ORCA_DEV_USER_DATA_PATH: profileDir }),
    stdio: 'inherit'
  })
  track(child, 'desktop')
}

function openWebClient(pairing) {
  if (!pairing?.webClientUrl) {
    console.error(
      '[modes] no Web client URL (needs `pnpm build:web` so the server can serve out/web). Pairing URL was printed above.'
    )
    return
  }
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  console.error(`[modes] opening web client: ${pairing.webClientUrl}`)
  const opened = spawnSync(opener, [pairing.webClientUrl], {
    stdio: 'ignore',
    shell: process.platform === 'win32'
  })
  if (opened.status !== 0) {
    console.error(
      `[modes] could not auto-open a browser; open this URL manually:\n  ${pairing.webClientUrl}`
    )
  }
}

/** SSH connect still needs the in-app dialog, but we can make the environment
 *  ready: build the relay bundle and verify a localhost sshd is reachable. */
function prepareSshArm() {
  runPackageScript('build:relay')
  if (cli.ssh === 'docker') {
    const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
    console.error(
      hasDocker
        ? '[modes] Docker detected. Use `pnpm test:e2e:ssh-docker-perf` for a throwaway sshd container, or add a host manually.'
        : '[modes] Docker not running — install/start Docker, or use `--ssh=localhost`.'
    )
    return
  }
  const reachable =
    spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', 'localhost', 'true'], {
      stdio: 'ignore'
    }).status === 0
  if (reachable) {
    console.error('[modes] localhost sshd reachable with non-interactive auth ✓')
  } else {
    console.error(
      '[modes] localhost SSH not ready. Enable it once:\n' +
        '  sudo systemsetup -setremotelogin on   # macOS Remote Login\n' +
        "  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''   # if you have no key\n" +
        '  cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys\n' +
        '  ssh -o BatchMode=yes localhost true   # must succeed non-interactively'
    )
  }
}

// ── Topology wiring ───────────────────────────────────────────────────────────

/** Writes the runtime server into the desktop profile's saved-server list via the
 *  supported CLI. Activating it stays a one-click UI step (see printNextSteps). */
function seedDesktopRuntimeEnvironment(desktopProfile, pairingUrl) {
  mkdirSync(desktopProfile, { recursive: true })
  console.error(`[modes] seeding runtime env "${REMOTE_ENV_NAME}" into desktop profile`)
  const result = spawnSync(
    process.execPath,
    [orcaDevScript, 'environment', 'add', '--name', REMOTE_ENV_NAME, '--pairing-code', pairingUrl],
    { cwd: repoRoot, stdio: 'inherit', env: childEnv({ ORCA_DEV_USER_DATA_PATH: desktopProfile }) }
  )
  if (result.status !== 0) {
    console.error(
      '[modes] environment add failed; add the server manually via Settings → Runtime Environments.'
    )
  }
}

// ── Build prerequisites ───────────────────────────────────────────────────────

function ensurePrerequisites(arms) {
  const wantsServe = arms.includes('serve')
  const wantsDesktop = arms.includes('desktop')
  // node-pty must load under the Electron ABI for both desktop and serve.
  if (wantsServe || wantsDesktop) {
    console.error('[modes] ensuring Electron native runtime (node-pty)…')
    run(process.execPath, [ensureRuntimeScript, '--runtime=electron'])
  }
  // orca-dev CLI (serve launcher + `environment add`).
  if (wantsServe || arms.includes('web') || mode.seedRemote) {
    ensureBuilt('build:cli', path.join(repoRoot, 'out', 'cli', 'index.js'))
  }
  // serve loads the prebuilt desktop main bundle (electron-vite dev does not).
  if (wantsServe) {
    ensureBuilt('build:electron-vite', path.join(repoRoot, 'out', 'main', 'index.js'))
  }
  // The runtime only prints a Web client URL when it can serve out/web.
  if (arms.includes('web')) {
    ensureBuilt('build:web', path.join(repoRoot, 'out', 'web', 'web-index.html'))
  }
  // SSH relay bundle is deployed to the remote host.
  if (arms.includes('ssh')) {
    ensureBuilt('build:relay', path.join(repoRoot, 'out', 'relay'))
  }
}

function ensureBuilt(script, artifact) {
  if (existsSync(artifact)) {
    return
  }
  console.error(`[modes] building ${script} (missing ${path.relative(repoRoot, artifact)})…`)
  runPackageScript(script)
}

// ── Process helpers ───────────────────────────────────────────────────────────

function childEnv(extra) {
  const env = { ...process.env, ...extra }
  if (process.platform === 'darwin') {
    // Why: launch rebuilds node-pty for the Electron ABI; if a non-Apple c++
    // (e.g. a corp GCC) is first on PATH it rejects clang's -stdlib=libc++ and the
    // build fails. Default to Apple clang unless the caller set a compiler.
    env.CC = env.CC || '/usr/bin/clang'
    env.CXX = env.CXX || '/usr/bin/clang++'
  }
  if (process.platform === 'linux') {
    // Temp dev profiles have no root-owned chrome-sandbox; local testing only.
    env.ELECTRON_DISABLE_SANDBOX = env.ELECTRON_DISABLE_SANDBOX || '1'
  }
  return env
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: childEnv({}) })
  if (result.status !== 0) {
    console.error(`[modes] command failed: ${command} ${args.join(' ')}`)
    cleanup()
    process.exit(result.status ?? 1)
  }
}

function runPackageScript(script) {
  const pmExec = process.env.npm_execpath
  if (pmExec) {
    run(process.execPath, [pmExec, 'run', script])
    return
  }
  const result = spawnSync('pnpm', ['run', script], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: childEnv({}),
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    console.error(`[modes] pnpm run ${script} failed (is pnpm on PATH?).`)
    cleanup()
    process.exit(result.status ?? 1)
  }
}

function track(child, label) {
  children.push({ child, label })
  child.once('exit', (code, signal) => {
    console.error(`[modes] ${label} exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`)
  })
  child.once('error', (error) => {
    console.error(`[modes] ${label} failed to start: ${error.message}`)
  })
}

function installSignalHandlers() {
  process.on('SIGINT', () => {
    console.error('\n[modes] stopping…')
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
}

function cleanup() {
  if (tornDown) {
    return
  }
  tornDown = true
  for (const { child } of children) {
    killTree(child)
  }
  if (!cli.keep && existsSync(baseDir) && baseDir.includes(path.join('orca-modes', runId))) {
    try {
      rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      console.error(`[modes] removed ${baseDir}`)
    } catch (error) {
      console.error(`[modes] kept ${baseDir} (${error instanceof Error ? error.message : error})`)
    }
  } else if (cli.keep) {
    console.error(`[modes] kept ${baseDir}`)
  }
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return
  }
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return
  }
  if (child.pid) {
    try {
      // Kill the whole process group (serve/dev own Electron/CLI descendants).
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // Group already gone; fall through to a direct kill.
    }
  }
  child.kill('SIGTERM')
}

// ── Parsing & output ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    mode: null,
    dryRun: false,
    keep: false,
    noBuild: false,
    ssh: 'localhost',
    help: false
  }
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      out.help = true
    } else if (arg === '--dry-run') {
      out.dryRun = true
    } else if (arg === '--keep') {
      out.keep = true
    } else if (arg === '--no-build') {
      out.noBuild = true
    } else if (arg === '--ssh=docker') {
      out.ssh = 'docker'
    } else if (arg === '--ssh=localhost') {
      out.ssh = 'localhost'
    } else if (!arg.startsWith('-') && !out.mode) {
      out.mode = arg
    } else {
      console.error(`[modes] ignoring unknown argument: ${arg}`)
    }
  }
  return out
}

function matchAfter(line, prefix) {
  const idx = line.indexOf(prefix)
  if (idx === -1) {
    return null
  }
  const value = line.slice(idx + prefix.length).trim()
  return value && value !== 'unavailable' ? value : null
}

function printPlan() {
  const arms = mode.arms.map((arm) => {
    if (arm === 'serve') {
      return `serve → 127.0.0.1:${SERVE_PORT_BASE}, profile ${path.join(baseDir, 'server')}`
    }
    if (arm === 'desktop') {
      return `desktop → profile ${path.join(baseDir, 'desk')}`
    }
    if (arm === 'web') {
      return "web → auto-open the server's Web client URL"
    }
    if (arm === 'ssh') {
      return `ssh (${cli.ssh}) → build relay + reachability check`
    }
    return arm
  })
  console.error('[modes] DRY RUN — would launch:')
  for (const line of arms) {
    console.error(`  • ${line}`)
  }
  if (mode.seedRemote) {
    console.error(`  • seed runtime env "${REMOTE_ENV_NAME}" into the desktop profile`)
  }
}

function printNextSteps(pairing) {
  console.error('\n[modes] ───────────────────────────────────────────────')
  if (mode.seedRemote) {
    console.error(
      `[modes] In the desktop app: Settings → Runtime Environments → connect "${REMOTE_ENV_NAME}"\n` +
        '[modes] (the remote server is pre-added; one click activates it so repos route to runtime:<env>).'
    )
  }
  if (mode.arms.includes('serve') && pairing?.pairingUrl) {
    console.error(`[modes] Pairing URL (bearer token — treat as secret):\n  ${pairing.pairingUrl}`)
  }
  if (mode.arms.includes('ssh')) {
    console.error(
      '[modes] Add the SSH host in the app: sidebar → Add → Remote host (SSH) → host 127.0.0.1, your user, your key.'
    )
  }
  if (children.length > 0) {
    console.error('[modes] Press Ctrl+C to stop every arm and clean up profiles.')
  }
}

function printHelp() {
  console.log(`Usage: pnpm dev:mode <mode> [flags]

Launch Orca in a local host topology for testing. Modes:
  local              desktop app only (local host)
  remote             headless 'orca serve' runtime + auto-paired web client
  local-remote       desktop app + runtime server (pre-seeded into the app)
  local-ssh          desktop app + localhost-SSH prep
  local-remote-ssh   desktop + runtime server + SSH prep

Flags:
  --dry-run          print the plan (arms/ports/profiles) and exit
  --keep             keep the temp profiles after exit
  --no-build         skip auto-building prerequisites (cli/main/web/relay)
  --ssh=localhost    (default) prepare a localhost SSH host
  --ssh=docker       check for Docker for a throwaway sshd container
  -h, --help         show this help

Each host gets an isolated userData profile under a short /tmp path (so the
macOS daemon UNIX socket stays under the ~104-char limit). See
docs/local-multi-host-test-modes.md.`)
}

main().catch((error) => {
  console.error(`[modes] ${error instanceof Error ? error.message : error}`)
  cleanup()
  process.exit(1)
})
