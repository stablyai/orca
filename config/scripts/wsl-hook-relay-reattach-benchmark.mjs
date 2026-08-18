import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createJiti } from 'jiti'

const DEFAULT_SAMPLES = 20
const PANE_KEY = 'wsl-relay-bench:11111111-1111-4111-8111-111111111111'
const WSL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const TERMINAL_COLS = 80
const TERMINAL_ROWS = 24

function parseArgs(argv) {
  const options = { distro: null, samples: DEFAULT_SAMPLES }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--distro') {
      options.distro = argv[++index] ?? null
    } else if (arg === '--samples') {
      options.samples = Number(argv[++index])
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!Number.isInteger(options.samples) || options.samples < 5 || options.samples > 100) {
    throw new Error('--samples must be an integer between 5 and 100')
  }
  return options
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (status) => {
      const result = {
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      }
      if (status === 0 || options.allowFailure) {
        resolve(result)
      } else {
        reject(new Error(`${command} exited ${status}: ${result.stderr.trim()}`))
      }
    })
    child.stdin.end(options.input)
  })
}

function wslArgs(distro, args) {
  return ['-d', distro, '--exec', ...args]
}

async function resolveDistro(requested) {
  if (requested) {
    return requested
  }
  const listed = await run('wsl.exe', ['--list', '--quiet'], {
    env: { ...process.env, WSL_UTF8: '1' }
  })
  const distro = listed.stdout
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean)
  if (!distro) {
    throw new Error('No WSL distro is installed')
  }
  return distro
}

async function readGuestFile(distro, path) {
  const result = await run('wsl.exe', wslArgs(distro, ['/bin/cat', path]), {
    allowFailure: true
  })
  return result.status === 0 ? result.stdout : null
}

async function waitFor(description, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function parseEndpoint(contents) {
  const port = Number(/ORCA_AGENT_HOOK_PORT=['"]?(\d+)/.exec(contents)?.[1])
  const token = /ORCA_AGENT_HOOK_TOKEN=['"]?([^'"\r\n]+)/.exec(contents)?.[1]
  return Number.isInteger(port) && port > 0 && token ? { port, token } : null
}

async function freeGuestPort(distro) {
  const result = await run(
    'wsl.exe',
    wslArgs(distro, [
      '/usr/bin/python3',
      '-c',
      'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
    ])
  )
  const port = Number(result.stdout.trim())
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not reserve a guest port: ${result.stdout}`)
  }
  return port
}

async function startStallingGuestServer(distro) {
  const source = [
    'import socket,sys,threading',
    'stop=threading.Event()',
    'threading.Thread(target=lambda:(sys.stdin.buffer.read(),stop.set()),daemon=True).start()',
    'server=socket.socket()',
    'server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)',
    'server.bind(("127.0.0.1",0))',
    'server.listen()',
    'server.settimeout(0.1)',
    'print(f"READY {server.getsockname()[1]}",flush=True)',
    'held=[]',
    'while not stop.is_set():',
    ' try:',
    '  client,_=server.accept(); held.append(client); print("ACCEPT",flush=True)',
    ' except TimeoutError: pass',
    'for client in held: client.close()',
    'server.close()'
  ].join('\n')
  const child = spawn('wsl.exe', wslArgs(distro, ['/usr/bin/python3', '-u', '-c', source]), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  let accepted = 0
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8')
    accepted += chunk.toString('utf8').split('ACCEPT').length - 1
  })
  const port = await waitFor('stalling WSL listener', async () => {
    const match = /READY (\d+)/.exec(output)
    return match ? Number(match[1]) : null
  })
  return {
    port,
    accepted: () => accepted,
    stop: async () => {
      child.stdin.end()
      await new Promise((resolve) => child.once('close', resolve))
    }
  }
}

async function writeEndpoint(distro, path, endpoint) {
  const contents = [
    `ORCA_AGENT_HOOK_PORT=${endpoint.port}`,
    `ORCA_AGENT_HOOK_TOKEN=${endpoint.token}`,
    'ORCA_AGENT_HOOK_ENV=benchmark',
    'ORCA_AGENT_HOOK_VERSION=1',
    ''
  ].join('\n')
  await run(
    'wsl.exe',
    wslArgs(distro, [
      '/bin/sh',
      '-c',
      'umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"',
      'orca-wsl-benchmark',
      path
    ]),
    { input: contents }
  )
}

async function invokeHook(distro, scriptPath, endpointPath) {
  const startedAt = performance.now()
  const result = await run(
    'wsl.exe',
    wslArgs(distro, [
      '/usr/bin/env',
      `PATH=${WSL_PATH}`,
      `ORCA_AGENT_HOOK_ENDPOINT=${endpointPath}`,
      `ORCA_PANE_KEY=${PANE_KEY}`,
      'ORCA_TAB_ID=wsl-relay-bench',
      'ORCA_WORKTREE_ID=wsl-relay-bench',
      '/bin/sh',
      scriptPath
    ]),
    { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'benchmark' }) }
  )
  return { status: result.status, elapsedMs: performance.now() - startedAt }
}

/** Captures the PTY controller that registerPtyHandlers installs; every other runtime
 *  call the spawn path makes is a no-op so main's real lifecycle ordering still runs. */
function createRuntimeStub() {
  let controller = null
  const own = {
    setPtyController: (next) => {
      controller = next
    }
  }
  // Why no `has: () => true`: feature detection (`'x' in runtime`, typeof checks) must
  // not claim methods exist when they are only auto-stubbed getters.
  const runtime = new Proxy(own, {
    get: (target, property) => {
      if (property in target) {
        return target[property]
      }
      return typeof property === 'string' && property !== 'then' ? () => undefined : undefined
    }
  })
  return { runtime, getController: () => controller }
}

function createRendererWindowStub() {
  const webContents = {
    id: 1,
    on: () => {},
    once: () => {},
    removeListener: () => {},
    send: () => {},
    isDestroyed: () => false,
    session: { on: () => {} }
  }
  return { webContents, on: () => {}, once: () => {}, isDestroyed: () => false }
}

function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1]
}

function summarize(samples) {
  return {
    samples: samples.length,
    medianMs: Number(percentile(samples, 50).toFixed(1)),
    p95Ms: Number(percentile(samples, 95).toFixed(1)),
    minMs: Number(Math.min(...samples).toFixed(1)),
    maxMs: Number(Math.max(...samples).toFixed(1))
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This benchmark requires a Windows host with WSL')
  }
  const options = parseArgs(process.argv.slice(2))
  const distro = await resolveDistro(options.distro)
  const nodeVersion = await run(
    'wsl.exe',
    wslArgs(distro, [
      '/bin/sh',
      '-c',
      'for node_bin in "$(command -v node 2>/dev/null || true)" "$HOME/.local/bin/node"; do [ -x "$node_bin" ] || continue; "$node_bin" -p process.versions.node && exit 0; done; exit 1'
    ]),
    { allowFailure: true }
  )
  if (nodeVersion.status !== 0 || Number(nodeVersion.stdout.trim().split('.')[0]) < 18) {
    throw new Error(`WSL distro '${distro}' needs Node.js 18 or newer to run Orca's relay`)
  }

  const bundleDir = join(process.cwd(), 'out', 'relay', 'wsl')
  const bundlePath = join(bundleDir, 'wsl-agent-hook-relay.js')
  const versionPath = join(bundleDir, '.version')
  if (!existsSync(bundlePath) || !existsSync(versionPath)) {
    await run(process.execPath, [join('config', 'scripts', 'build-relay.mjs')], {
      cwd: process.cwd()
    })
  }

  // Why: main's PTY graph reads app paths at import time; keep it inside a disposable directory.
  let userDataDir
  let ptyIpc
  let cleanupPaths = []
  let manager = null
  let staller = null
  try {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-wsl-relay-bench-'))
    process.env.ORCA_USER_DATA_PATH = userDataDir
    const jiti = createJiti(import.meta.url, {
      alias: {
        electron: fileURLToPath(
          new URL('./wsl-hook-relay-reattach-benchmark-electron-stub.mjs', import.meta.url)
        )
      }
    })
    // Why sequential: concurrent jiti.import calls can each instantiate the module graph, and two
    // copies of wsl-hook-relay-manager.ts would leave pty.ts refreshing a singleton we never see.
    ptyIpc = await jiti.import('../../src/main/ipc/pty.ts')
    const { WslHookRelayManager, wslHookRelayManager } = await jiti.import(
      '../../src/main/agent-hooks/wsl-hook-relay-manager.ts'
    )
    const { ensureWslHookRelayForReattach } = await jiti.import(
      '../../src/main/agent-hooks/wsl-hook-relay-reattach.ts'
    )
    const { codexHookService } = await jiti.import('../../src/main/codex/hook-service.ts')
    const { MANAGED_AGENT_HOOK_TARGETS } = await jiti.import(
      '../../src/shared/managed-agent-hook-targets.ts'
    )
    const { toWindowsWslPath } = await jiti.import('../../src/shared/wsl-paths.ts')
    const { FLOATING_TERMINAL_WORKTREE_ID } = await jiti.import('../../src/shared/constants.ts')

    // Why: if jiti ever returns a second manager module, our monkey-patch would miss the singleton
    // that ensureWslHookRelayForReattach (loaded via pty.ts) closes over — fail closed now.
    const singletonProbe = []
    const previousEnsure = wslHookRelayManager.ensureForDistro.bind(wslHookRelayManager)
    wslHookRelayManager.ensureForDistro = (probedDistro) => {
      singletonProbe.push(probedDistro)
    }
    ensureWslHookRelayForReattach(
      { isReattach: true, wslDistro: '__bench-singleton-probe__' },
      null
    )
    wslHookRelayManager.ensureForDistro = previousEnsure
    if (singletonProbe.length !== 1 || singletonProbe[0] !== '__bench-singleton-probe__') {
      throw new Error(
        'jiti duplicated the WSL hook-relay manager graph; reattach patch would not observe pty.ts'
      )
    }

    const guestHome = (
      await run('wsl.exe', wslArgs(distro, ['/bin/sh', '-c', 'printf %s "$HOME"']))
    ).stdout.trim()
    const instanceKey = `bench-${process.pid}-${Date.now().toString(36)}`
    const benchmarkRoot = `${guestHome}/.orca-wsl/benchmarks/${instanceKey}`
    const scriptPath = `${benchmarkRoot}/.orca/agent-hooks/codex-hook.sh`
    const endpointPath = `${guestHome}/.orca-wsl/agent-hooks/instance-${instanceKey}/endpoint.env`
    cleanupPaths = [benchmarkRoot, `${guestHome}/.orca-wsl/agent-hooks/instance-${instanceKey}`]
    if (cleanupPaths.some((cleanupPath) => !cleanupPath.startsWith(`${guestHome}/.orca-wsl/`))) {
      throw new Error('Refusing to use an unexpected guest cleanup path')
    }
    const disabledTuiAgents = MANAGED_AGENT_HOOK_TARGETS.filter(
      (target) => target.tuiAgent !== 'codex'
    ).map((target) => target.tuiAgent)
    const bundleVersion = readFileSync(versionPath, 'utf8').trim()
    const warnings = []
    const relayRefreshes = []
    let delivered = 0

    // Why: pty.ts refreshes through the production singleton, so route that singleton at the
    // benchmark-scoped manager instead of calling the reattach helper from here — a removed or
    // mislocated integration call in pty.ts must fail this benchmark.
    wslHookRelayManager.ensureForDistro = (refreshedDistro) => {
      relayRefreshes.push(refreshedDistro)
      manager?.ensureForDistro(refreshedDistro)
    }

    const { runtime, getController } = createRuntimeStub()
    // Why hooks off: fresh WSL spawn still runs buildPtyHostEnv, which calls ensureForDistro when
    // hooks are on. This bench isolates the reattach call site (ensureWslHookRelayForReattach);
    // the manager's own hooks gate lives behind the ensureForDistro patch above, so it stays out
    // of the measurement — `manager` below resolves its own (enabled) managed-hook settings.
    ptyIpc.registerPtyHandlers(
      createRendererWindowStub(),
      runtime,
      undefined,
      () => ({ agentStatusHooksEnabled: false }),
      undefined,
      undefined,
      {}
    )
    const ptyController = getController()
    if (typeof ptyController?.spawn !== 'function') {
      throw new Error('registerPtyHandlers did not install a runtime PTY controller')
    }
    const survivingSessionId = `orca-wsl-relay-bench-${instanceKey}`
    const spawnSurvivingPty = () =>
      ptyController.spawn({
        cols: TERMINAL_COLS,
        rows: TERMINAL_ROWS,
        // Why floating: without a worktree root main drops the requested cwd, and the UNC path is
        // what makes the local provider launch this PTY inside the distro under test.
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        cwd: toWindowsWslPath(guestHome, distro),
        sessionId: survivingSessionId
      })

    const createManager = async (token) => {
      const preferredPort = await freeGuestPort(distro)
      return new WslHookRelayManager({
        platform: () => 'win32',
        remoteHooksEnabled: () => true,
        hookCoordsEnv: () => ({
          ORCA_AGENT_HOOK_PORT: String(preferredPort),
          ORCA_AGENT_HOOK_TOKEN: token,
          ORCA_AGENT_HOOK_ENV: 'benchmark',
          ORCA_AGENT_HOOK_VERSION: '1'
        }),
        instanceKey: () => instanceKey,
        resolveBundle: () => ({ jsPath: bundlePath, version: bundleVersion }),
        listDistros: async () => [distro],
        ingest: () => {
          delivered++
        },
        installHooks: async (sftp) => [
          await codexHookService.installRemote(sftp, benchmarkRoot, {
            codexHomeDir: `${benchmarkRoot}/codex-home`,
            deferTrustUntilConfigToml: true
          })
        ],
        managedHookSettings: () => ({
          agentCmdOverrides: { codex: '/bin/true' },
          disabledTuiAgents
        }),
        pluginSources: () => ({}),
        warn: (message) => warnings.push(message),
        transientRetryDelayMs: 100
      })
    }

    manager = await createManager('before-restart-token')
    manager.ensureForDistro(distro)
    await waitFor('initial relay and generated Codex hook', async () => {
      const [endpoint, script] = await Promise.all([
        readGuestFile(distro, endpointPath),
        readGuestFile(distro, scriptPath)
      ])
      return endpoint?.includes('before-restart-token') && script?.includes('--max-time')
    })

    const survivingPty = await spawnSurvivingPty()
    if (relayRefreshes.length > 0) {
      throw new Error(`Fresh WSL spawn refreshed the relay: ${relayRefreshes.join(', ')}`)
    }

    manager.disposeAll()
    manager = null

    staller = await startStallingGuestServer(distro)
    await writeEndpoint(distro, endpointPath, {
      port: staller.port,
      token: 'stale-token'
    })

    await invokeHook(distro, scriptPath, endpointPath)
    const staleSamples = []
    for (let index = 0; index < options.samples; index++) {
      staleSamples.push((await invokeHook(distro, scriptPath, endpointPath)).elapsedMs)
    }

    delivered = 0
    manager = await createManager('after-restart-token')
    // Reattach the surviving WSL PTY through main's real spawn path — no direct helper call.
    // Why delta: only the reattach phase should record ensureForDistro; length alone can false-
    // green if an earlier phase already refreshed (or if a future hooks-on change reintroduces it).
    const refreshesBeforeReattach = relayRefreshes.length
    const reattachedPty = await spawnSurvivingPty()
    if (reattachedPty.id !== survivingPty.id) {
      throw new Error(
        `Expected to reattach PTY ${survivingPty.id}, main spawned ${reattachedPty.id}`
      )
    }
    const reattachRefreshes = relayRefreshes.slice(refreshesBeforeReattach)
    if (reattachRefreshes.length !== 1 || reattachRefreshes[0] !== distro) {
      throw new Error(
        `PTY reattach did not refresh the relay for '${distro}': before=${refreshesBeforeReattach} all=[${relayRefreshes.join(', ')}]`
      )
    }
    const refreshedEndpoint = await waitFor('reattached relay endpoint rewrite', async () => {
      const contents = await readGuestFile(distro, endpointPath)
      const parsed = contents ? parseEndpoint(contents) : null
      return parsed && parsed.token === 'after-restart-token' ? parsed : null
    })

    await invokeHook(distro, scriptPath, endpointPath)
    await waitFor('refreshed hook warmup delivery', async () => (delivered >= 1 ? true : null))
    delivered = 0
    const refreshedSamples = []
    for (let index = 0; index < options.samples; index++) {
      refreshedSamples.push((await invokeHook(distro, scriptPath, endpointPath)).elapsedMs)
    }
    await waitFor('all refreshed hooks to reach the host', async () =>
      delivered >= options.samples ? true : null
    )

    const stale = summarize(staleSamples)
    const refreshed = summarize(refreshedSamples)
    const result = {
      distro,
      endpointPath,
      endpointPortAfterReattach: refreshedEndpoint.port,
      reattachedPtyId: reattachedPty.id,
      relayRefreshes,
      reattachRefreshes,
      stale,
      refreshed,
      medianSpeedup: Number((stale.medianMs / refreshed.medianMs).toFixed(1)),
      stalledConnections: staller.accepted(),
      delivered,
      warnings
    }
    console.log(JSON.stringify(result, null, 2))

    if (stale.medianMs < 1_000) {
      throw new Error(`Stale endpoint did not exercise the timeout path: ${stale.medianMs}ms`)
    }
    if (refreshed.p95Ms >= 1_000) {
      throw new Error(`Refreshed endpoint p95 regressed: ${refreshed.p95Ms}ms`)
    }
    if (delivered !== options.samples) {
      throw new Error(`Expected ${options.samples} delivered hooks, received ${delivered}`)
    }
  } finally {
    manager?.disposeAll()
    await staller?.stop()
    ptyIpc?.killAllPty?.()
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
    for (const cleanupPath of cleanupPaths) {
      await run('wsl.exe', wslArgs(distro, ['/bin/rm', '-rf', '--', cleanupPath]), {
        allowFailure: true
      })
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
