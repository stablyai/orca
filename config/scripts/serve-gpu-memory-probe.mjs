/**
 * GPU-memory repro harness: boots the BUILT headless runtime server (`out/main/index.js --serve`),
 * pairs a real client over the advertised endpoint, opens N browser tabs on data-heavy pages,
 * and samples GPU-process memory every few seconds, printing a CSV series and a summary.
 *
 * Pairs with `pnpm run bench:serve-gpu-memory`.
 *
 * Metrics source: the `diagnostics.memory` RPC (`runtime.getMemorySnapshot()`,
 * src/main/memory/collector.ts). That snapshot buckets Electron app metrics into
 * main / renderer / other — GPU and utility helpers land in `app.other` (see
 * `bucketElectronMetrics`), so `other.memory` is our per-sample GPU-process RSS proxy.
 * The CLI equivalent is `orca diagnostics memory --pairing-code <code> --json`.
 *
 * Reproducing OLD (pre-idle-sleep) behavior — `--mode control`:
 *   before boot, write into <user-data-dir>/orca-data.json:
 *     { "settings": { "serveBrowserPaintMode": "always", "serveBrowserIdleSleepSeconds": 0 } }
 *   the script writes that file itself (it owns --user-data-dir), so `--mode control` does it
 *   for you; default mode (`treatment`) leaves the settings file absent.
 *
 * Exit code 0 unless boot/pairing/tab creation fails; sampling and summary never fail the run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const projectDir = resolve(import.meta.dirname, '../..')
const serveEntry = join(projectDir, 'out', 'main', 'index.js')
const READY_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 15_000
// Why a random high port: a fixed one collides with a developer's own `orca serve`.
const PORT = 6900 + Math.floor(Math.random() * 100)

const DEFAULT_URLS = [
  'https://example.com',
  'https://news.ycombinator.com',
  'https://en.wikipedia.org/wiki/JavaScript'
]

function log(message) {
  process.stdout.write(`[serve-gpu-memory-probe] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[serve-gpu-memory-probe] FAIL: ${message}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i !== -1 ? argv[i + 1] : undefined
  }
  return {
    tabs: Number(get('--tabs') ?? 10),
    durationS: Number(get('--duration-s') ?? 300),
    intervalS: Number(get('--interval-s') ?? 5),
    urlPrefix: get('--url-prefix'),
    mode: get('--mode') ?? 'treatment'
  }
}

/** Prefer the CLI built from this checkout over whatever `orca` is on PATH. */
function resolveCli() {
  const built = join(projectDir, 'out', 'cli', 'index.js')
  return existsSync(built)
    ? { command: process.execPath, prefix: [built] }
    : { command: 'orca', prefix: [] }
}

/** The `orca` CLI, driven with an explicit pairing code so it targets this server only. */
function orca(pairingCode, args) {
  const cli = resolveCli()
  const result = spawnSync(
    cli.command,
    [...cli.prefix, ...args, '--pairing-code', pairingCode, '--json'],
    { encoding: 'utf8', shell: false }
  )
  if (result.error) {
    throw new Error(`orca ${args[0]} failed to spawn: ${result.error.message}`)
  }
  const line = (result.stdout ?? '').trim()
  if (!line.startsWith('{')) {
    throw new Error(`orca ${args.join(' ')} produced no JSON:\n${result.stdout}\n${result.stderr}`)
  }
  const parsed = JSON.parse(line)
  if (parsed.ok === false) {
    throw new Error(
      `orca ${args.join(' ')} returned ${parsed.error?.code}: ${parsed.error?.message}`
    )
  }
  return parsed.result
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = ''
    let serverErr = ''
    const timer = setTimeout(
      () => rejectPromise(new Error(`no ready payload within ${READY_TIMEOUT_MS}ms`)),
      READY_TIMEOUT_MS
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      serverErr += chunk
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('{')) {
          continue
        }
        try {
          const payload = JSON.parse(line)
          if (payload.type === 'orca_server_ready') {
            clearTimeout(timer)
            resolvePromise(payload)
            return
          }
        } catch {
          // Partial line; wait for the rest.
        }
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(
        new Error(
          `server exited with ${code} before signalling ready${
            serverErr.trim() ? `:\n${serverErr.trim()}` : ' (no stderr)'
          }`
        )
      )
    })
  })
}

function pairingCodeFrom(payload) {
  const url = payload?.pairing?.url
  if (!url) {
    throw new Error('ready payload carried no pairing offer')
  }
  const code = new URL(url).searchParams.get('code')
  if (!code) {
    throw new Error(`pairing url had no code: ${url}`)
  }
  return code
}

/**
 * `--mode control` writes the settings that disable serve-browser idle sleep and force
 * always-on painting, i.e. the pre-optimization behavior the treatment mode is measured against.
 */
function applyControlMode(userDataDir) {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(
    join(userDataDir, 'orca-data.json'),
    JSON.stringify({
      settings: { serveBrowserPaintMode: 'always', serveBrowserIdleSleepSeconds: 0 }
    })
  )
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

async function main() {
  const { tabs, durationS, intervalS, urlPrefix, mode } = parseArgs(process.argv)
  if (!Number.isFinite(tabs) || tabs < 1) {
    throw new Error(`--tabs must be a positive number, got '${tabs}'`)
  }
  if (mode !== 'control' && mode !== 'treatment') {
    throw new Error(`--mode must be 'control' or 'treatment', got '${mode}'`)
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'orca-serve-gpu-probe-'))
  if (mode === 'control') {
    applyControlMode(userDataDir)
    log(
      `control mode: wrote always-paint / no-idle-sleep settings to ${userDataDir}/orca-data.json`
    )
  }
  log(`booting electron serve on port ${PORT} (mode=${mode}, tabs=${tabs}, duration=${durationS}s)`)

  const serveArgs = [
    serveEntry,
    '--serve',
    '--serve-port',
    String(PORT),
    '--serve-json',
    `--user-data-dir=${userDataDir}`
  ]
  const child = spawn('npx', ['electron', ...serveArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })

  try {
    const ready = await waitForReady(child)
    log(`ready: ${ready.advertisedEndpoint}`)
    const pairingCode = pairingCodeFrom(ready)

    const urls = urlPrefix
      ? Array.from({ length: tabs }, (_, i) => `${urlPrefix.replace(/\/$/, '')}/?tab=${i}`)
      : Array.from({ length: tabs }, (_, i) => DEFAULT_URLS[i % DEFAULT_URLS.length])

    const pageIds = []
    for (const url of urls) {
      const pageId = orca(pairingCode, ['tab', 'create', '--url', url])?.browserPageId
      if (!pageId) {
        throw new Error(`browser.tabCreate returned no browser page id for ${url}`)
      }
      pageIds.push(pageId)
    }
    log(`created ${pageIds.length} tabs`)

    process.stdout.write('t_seconds,gpu_other_rss_mb,total_app_rss_mb\n')
    const gpuSeries = []
    const totalSeries = []
    const deadline = Date.now() + durationS * 1000
    while (Date.now() < deadline) {
      const started = Date.now()
      // app.other = GPU + utility helpers (bucketElectronMetrics), the closest
      // wire-visible proxy for the GPU process; fall back to snapshot totals.
      const snapshot = orca(pairingCode, ['diagnostics', 'memory'])
      const gpuMb = (snapshot?.app?.other?.memory ?? snapshot?.totalMemory ?? 0) / (1024 * 1024)
      const totalMb = (snapshot?.app?.memory ?? snapshot?.totalMemory ?? 0) / (1024 * 1024)
      const t = ((started - deadline) / 1000 + durationS).toFixed(0)
      process.stdout.write(`${t},${gpuMb.toFixed(1)},${totalMb.toFixed(1)}\n`)
      gpuSeries.push(gpuMb)
      totalSeries.push(totalMb)
      const elapsed = Date.now() - started
      await new Promise((r) => setTimeout(r, Math.max(0, intervalS * 1000 - elapsed)))
    }

    const summarize = (name, values) => {
      if (!values.length) {
        return `${name}: no samples`
      }
      return (
        `${name}: peak=${Math.max(...values).toFixed(1)}MB ` +
        `final=${values.at(-1).toFixed(1)}MB median=${median(values).toFixed(1)}MB`
      )
    }
    log(summarize('gpu(other)', gpuSeries))
    log(summarize('app-total', totalSeries))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise((r) => child.on('exit', () => r(true))),
        new Promise((r) => setTimeout(() => r(false), SHUTDOWN_TIMEOUT_MS))
      ])
      if (!exited) {
        child.kill('SIGKILL')
      }
    }
    rmSync(userDataDir, { recursive: true, force: true })
  }

  if (!process.exitCode) {
    log('PASS')
  }
}

await main()
