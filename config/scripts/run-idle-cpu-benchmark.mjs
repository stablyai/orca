#!/usr/bin/env node
import { _electron as electron } from '@stablyai/playwright-test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installSyntheticVisibleSpinners } from './idle-cpu-synthetic-spinners.mjs'

const DEFAULT_WARMUP_MS = 15_000
const DEFAULT_SAMPLE_MS = 30_000
const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_WORKTREE_COUNT = 1
const ONBOARDING_FINAL_STEP = 3
const ONBOARDING_FLOW_VERSION = 2

function parseArgs(argv) {
  const options = {
    warmupMs: DEFAULT_WARMUP_MS,
    sampleMs: DEFAULT_SAMPLE_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    worktrees: DEFAULT_WORKTREE_COUNT,
    skipBuild: false,
    headful: false,
    output: null,
    disableRendererAnimations: false,
    syntheticVisibleSpinners: 0,
    syntheticSpinnerAnimation: 'smooth',
    syntheticSpinnerSteps: 12
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const readValue = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      index += 1
      return value
    }
    if (arg === '--') {
      continue
    } else if (arg === '--warmup-ms') {
      options.warmupMs = Number(readValue())
    } else if (arg === '--sample-ms') {
      options.sampleMs = Number(readValue())
    } else if (arg === '--interval-ms') {
      options.intervalMs = Number(readValue())
    } else if (arg === '--worktrees') {
      options.worktrees = Number(readValue())
    } else if (arg === '--output') {
      options.output = readValue()
    } else if (arg === '--skip-build') {
      options.skipBuild = true
    } else if (arg === '--headful') {
      options.headful = true
    } else if (arg === '--disable-renderer-animations') {
      options.disableRendererAnimations = true
    } else if (arg === '--synthetic-visible-spinners') {
      options.syntheticVisibleSpinners = Number(readValue())
    } else if (arg === '--synthetic-spinner-animation') {
      options.syntheticSpinnerAnimation = readValue()
    } else if (arg === '--synthetic-spinner-steps') {
      options.syntheticSpinnerSteps = Number(readValue())
    } else if (arg === '--help') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  for (const key of [
    'warmupMs',
    'sampleMs',
    'intervalMs',
    'worktrees',
    'syntheticVisibleSpinners',
    'syntheticSpinnerSteps'
  ]) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new Error(`Invalid --${key}: ${options[key]}`)
    }
  }
  options.worktrees = Math.max(1, Math.floor(options.worktrees))
  options.intervalMs = Math.max(250, Math.floor(options.intervalMs))
  options.syntheticVisibleSpinners = Math.max(0, Math.floor(options.syntheticVisibleSpinners))
  options.syntheticSpinnerSteps = Math.max(1, Math.floor(options.syntheticSpinnerSteps))
  if (!['smooth', 'steps'].includes(options.syntheticSpinnerAnimation)) {
    throw new Error(`Invalid --synthetic-spinner-animation: ${options.syntheticSpinnerAnimation}`)
  }
  return options
}
function printUsage() {
  console.log(
    `Usage: node config/scripts/run-idle-cpu-benchmark.mjs [options]\n\nOptions:\n  --warmup-ms <n>    Time to wait after app readiness before sampling (default ${DEFAULT_WARMUP_MS})\n  --sample-ms <n>    Sampling window duration (default ${DEFAULT_SAMPLE_MS})\n  --interval-ms <n>  Sampling cadence (default ${DEFAULT_INTERVAL_MS})\n  --worktrees <n>    Seed repo worktree count, including primary (default ${DEFAULT_WORKTREE_COUNT})\n  --headful          Show the Electron window while measuring\n  --skip-build       Reuse out/main/index.js instead of building first\n  --output <path>    Write JSON report to this path\n  --disable-renderer-animations  Inject measurement-only CSS that disables animations/transitions\n  --synthetic-visible-spinners <n>  Measurement-only: add visible working spinners\n  --synthetic-spinner-animation <smooth|steps>  Spinner animation style (default smooth)\n  --synthetic-spinner-steps <n>  Step count for --synthetic-spinner-animation steps (default 12)\n`
  )
}
function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: options.stdio ?? 'pipe', encoding: 'utf8', ...options })
}

function buildAppIfNeeded(root, skipBuild) {
  const mainPath = path.join(root, 'out', 'main', 'index.js')
  if (skipBuild && existsSync(mainPath)) {
    return mainPath
  }
  if (skipBuild) {
    throw new Error(`--skip-build requested, but ${mainPath} does not exist`)
  }
  console.log('[idle-cpu] building Electron app with electron-vite --mode e2e')
  run('npx', ['electron-vite', 'build', '--mode', 'e2e'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_EXPOSE_STORE: 'true' }
  })
  return mainPath
}

function makeCompletedOnboardingProfile() {
  return {
    settings: {
      telemetry: {
        optedIn: true,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: false
      }
    },
    onboarding: {
      flowVersion: ONBOARDING_FLOW_VERSION,
      closedAt: 1,
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    },
    ui: {
      contextualToursSeenIds: [
        'workspace-board',
        'browser',
        'tasks',
        'automations',
        'workspace-creation'
      ],
      contextualToursAutoEligible: false,
      projectOrderManualDefaultNoticeDismissed: true
    }
  }
}

function createIdleRepo(worktreeCount) {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'orca-idle-cpu-repo-'))
  const cleanupDirs = [repoDir]
  run('git', ['init'], { cwd: repoDir })
  run('git', ['config', 'user.email', 'idle-cpu@test.local'], { cwd: repoDir })
  run('git', ['config', 'user.name', 'Idle CPU Benchmark'], { cwd: repoDir })
  writeFileSync(path.join(repoDir, 'README.md'), '# Orca idle CPU benchmark\n')
  writeFileSync(
    path.join(repoDir, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`
  )
  mkdirSync(path.join(repoDir, 'src'), { recursive: true })
  writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const idleBenchmark = true\n')
  run('git', ['add', '-A'], { cwd: repoDir })
  run('git', ['commit', '-m', 'Initial idle CPU fixture'], { cwd: repoDir })
  for (let i = 2; i <= worktreeCount; i += 1) {
    const worktreeDir = path.join(
      path.dirname(repoDir),
      `orca-idle-cpu-worktree-${i}-${Date.now()}`
    )
    cleanupDirs.push(worktreeDir)
    run('git', ['worktree', 'add', worktreeDir, '-b', `idle-cpu-${i}`], { cwd: repoDir })
  }
  return { repoDir, cleanupDirs }
}

function launchArgs(mainPath, headful) {
  if (headful || process.platform !== 'linux') {
    return [mainPath]
  }
  return [
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--in-process-gpu',
    mainPath
  ]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseCpuTimeSeconds(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) {
    return null
  }
  const [dayOrTime, maybeTime] = trimmed.includes('-') ? trimmed.split('-', 2) : [null, trimmed]
  const days = dayOrTime === null ? 0 : Number(dayOrTime)
  const parts = maybeTime.split(':').map(Number)
  if (!Number.isFinite(days) || parts.some((part) => !Number.isFinite(part))) {
    return null
  }
  if (parts.length === 3) {
    return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  if (parts.length === 2) {
    return days * 86400 + parts[0] * 60 + parts[1]
  }
  if (parts.length === 1) {
    return days * 86400 + parts[0]
  }
  return null
}

function parseUnixProcesses(stdout) {
  const rows = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      percentCpu: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      cpuTimeSeconds: parseCpuTimeSeconds(match[5]),
      command: match[6]
    })
  }
  return rows
}

function readUnixProcesses() {
  const stdout = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,cputime=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    maxBuffer: 20 * 1024 * 1024
  })
  return parseUnixProcesses(stdout)
}

function readWindowsProcesses() {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'PowerShell process enumeration failed')
  }
  const parsed = JSON.parse(result.stdout || '[]')
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.map((entry) => ({
    pid: Number(entry.ProcessId),
    ppid: Number(entry.ParentProcessId),
    percentCpu: 0,
    cpuTimeSeconds: null,
    rssBytes: Number(entry.WorkingSetSize) || 0,
    command: String(entry.CommandLine || '')
  }))
}

function readProcessRows() {
  return process.platform === 'win32' ? readWindowsProcesses() : readUnixProcesses()
}

function descendantsOf(rows, rootPid) {
  const children = new Map()
  for (const row of rows) {
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const result = []
  const stack = [rootPid]
  const seen = new Set()
  while (stack.length > 0) {
    const pid = stack.pop()
    if (seen.has(pid)) {
      continue
    }
    seen.add(pid)
    const row = rows.find((candidate) => candidate.pid === pid)
    if (row) {
      result.push(row)
    }
    for (const child of children.get(pid) ?? []) {
      stack.push(child.pid)
    }
  }
  return result
}

function classify(row, rootPid) {
  const command = row.command.toLowerCase()
  if (row.pid === rootPid) {
    return 'main'
  }
  if (command.includes('daemon-entry')) {
    return 'daemon'
  }
  if (command.includes('--type=gpu-process')) {
    return 'gpu'
  }
  if (command.includes('--type=renderer')) {
    return 'renderer'
  }
  if (command.includes('--type=utility')) {
    return 'utility'
  }
  if (command.includes('--type=')) {
    return 'electron-other'
  }
  if (command.includes('node') || command.includes('/pi') || command.endsWith(' pi')) {
    return 'agent-or-node'
  }
  return 'other-descendant'
}

async function collectRendererIdleState(page) {
  return page.evaluate(() => {
    const describeElement = (element) => {
      if (!(element instanceof Element)) {
        return null
      }
      const classes = typeof element.className === 'string' ? element.className : ''
      const testId = element.getAttribute('data-testid')
      const label = element.getAttribute('aria-label')
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        testId,
        label,
        classes: classes.split(/\s+/).filter(Boolean).slice(0, 12),
        text: (element.textContent || '').trim().slice(0, 80)
      }
    }
    const animations = document.getAnimations({ subtree: true }).map((animation) => {
      const effect = animation.effect
      const target = effect instanceof KeyframeEffect ? effect.target : null
      return {
        playState: animation.playState,
        currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : null,
        playbackRate: animation.playbackRate,
        duration:
          effect instanceof KeyframeEffect && typeof effect.getTiming().duration === 'number'
            ? effect.getTiming().duration
            : null,
        iterations: effect instanceof KeyframeEffect ? effect.getTiming().iterations : null,
        target: describeElement(target)
      }
    })
    return {
      visibilityState: document.visibilityState,
      runningAnimationCount: animations.filter((animation) => animation.playState === 'running')
        .length,
      animations: animations.slice(0, 80)
    }
  })
}

function summarizeSamples(samples) {
  const byKind = new Map()
  for (const sample of samples) {
    for (const proc of sample.processes) {
      const bucket = byKind.get(proc.kind) ?? { cpuValues: [], rssValues: [], maxProcessCount: 0 }
      bucket.cpuValues.push(proc.cpu)
      bucket.rssValues.push(proc.rssBytes)
      byKind.set(proc.kind, bucket)
    }
    const counts = new Map()
    for (const proc of sample.processes) {
      counts.set(proc.kind, (counts.get(proc.kind) ?? 0) + 1)
    }
    for (const [kind, count] of counts) {
      byKind.get(kind).maxProcessCount = Math.max(byKind.get(kind).maxProcessCount, count)
    }
  }
  const summary = {}
  for (const [kind, values] of byKind) {
    const cpuSorted = [...values.cpuValues].sort((a, b) => a - b)
    const rssSumBySample = samples.map((sample) =>
      sample.processes
        .filter((proc) => proc.kind === kind)
        .reduce((sum, proc) => sum + proc.rssBytes, 0)
    )
    summary[kind] = {
      meanCpuPercent: mean(values.cpuValues),
      p95CpuPercent: percentile(cpuSorted, 0.95),
      maxCpuPercent: Math.max(0, ...values.cpuValues),
      meanRssBytes: mean(rssSumBySample),
      maxProcessCount: values.maxProcessCount
    }
  }
  summary.total = {
    meanCpuPercent: mean(samples.map((sample) => sample.totalCpuPercent)),
    p95CpuPercent: percentile(
      samples.map((sample) => sample.totalCpuPercent).sort((a, b) => a - b),
      0.95
    ),
    meanRssBytes: mean(samples.map((sample) => sample.totalRssBytes))
  }
  return summary
}

function summarizeProcessInventory(samples) {
  const inventory = {}
  for (const sample of samples) {
    const counts = new Map()
    for (const proc of sample.processes) {
      counts.set(proc.kind, (counts.get(proc.kind) ?? 0) + 1)
      const entry = inventory[proc.kind] ?? {
        maxProcessCount: 0,
        maxCpuPercent: 0,
        commandSamples: []
      }
      entry.maxCpuPercent = Math.max(entry.maxCpuPercent, proc.cpu)
      if (!entry.commandSamples.includes(proc.command) && entry.commandSamples.length < 6) {
        entry.commandSamples.push(proc.command)
      }
      inventory[proc.kind] = entry
    }
    for (const [kind, count] of counts) {
      inventory[kind].maxProcessCount = Math.max(inventory[kind].maxProcessCount, count)
    }
  }
  return inventory
}
function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0
  }
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index]
}

function terminateProcesses(processes) {
  for (const proc of processes) {
    try {
      process.kill(proc.pid)
    } catch {}
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = path.resolve(import.meta.dirname, '..', '..')
  const mainPath = buildAppIfNeeded(root, options.skipBuild)
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-idle-cpu-userdata-'))
  const { repoDir, cleanupDirs } = createIdleRepo(options.worktrees)
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(makeCompletedOnboardingProfile(), null, 2)}\n`
  )
  const {
    ELECTRON_RUN_AS_NODE,
    CODEX_HOME: _codexHome,
    ORCA_CODEX_HOME: _orcaCodexHome,
    ...cleanEnv
  } = process.env
  void ELECTRON_RUN_AS_NODE
  void _codexHome
  void _orcaCodexHome
  // Why: real-home rollout work would both contaminate idle measurements and
  // expose the developer Codex profile to this disposable Electron launch.
  const isolatedHome = path.join(userDataDir, 'home')
  mkdirSync(isolatedHome, { recursive: true })
  const app = await electron.launch({
    args: launchArgs(mainPath, options.headful),
    env: {
      ...cleanEnv,
      NODE_ENV: 'development',
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      ORCA_E2E_HOME_DIR: isolatedHome,
      ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME: '0',
      ...(options.headful ? { ORCA_E2E_HEADFUL: '1' } : { ORCA_E2E_HEADLESS: '1' })
    }
  })
  const rootPid = app.process().pid
  try {
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    const measurementCss = []
    if (options.disableRendererAnimations) {
      measurementCss.push(
        '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}'
      )
    }
    if (measurementCss.length > 0) {
      await page.addStyleTag({ content: measurementCss.join('\n') })
    }
    await installSyntheticVisibleSpinners(
      page,
      options.syntheticVisibleSpinners,
      options.syntheticSpinnerAnimation,
      options.syntheticSpinnerSteps
    )
    await page.evaluate(async (repoPath) => {
      await window.api.repos.add({ path: repoPath })
      const store = window.__store
      await store?.getState().fetchRepos()
      const repo = store?.getState().repos.find((candidate) => candidate.path === repoPath)
      if (repo) {
        await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
        await store.getState().fetchWorktrees(repo.id)
      }
    }, repoDir)
    await page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 60_000 }
    )
    console.log(
      `[idle-cpu] root pid=${rootPid}; warmup=${options.warmupMs}ms sample=${options.sampleMs}ms interval=${options.intervalMs}ms worktrees=${options.worktrees}`
    )
    await sleep(options.warmupMs)
    const rendererIdleState = await collectRendererIdleState(page)
    const deadline = Date.now() + options.sampleMs
    const samples = []
    let previousSnapshot = null
    while (Date.now() <= deadline || samples.length === 0) {
      const sampledAt = Date.now()
      const processRows = descendantsOf(readProcessRows(), rootPid)
      const rawProcesses = processRows.map((row) => ({ ...row, kind: classify(row, rootPid) }))
      if (previousSnapshot) {
        const elapsedSeconds = Math.max(0.001, (sampledAt - previousSnapshot.at) / 1000)
        const previousByPid = new Map(previousSnapshot.processes.map((proc) => [proc.pid, proc]))
        const processes = rawProcesses.map((row) => {
          const previous = previousByPid.get(row.pid)
          const canComputeDelta =
            typeof row.cpuTimeSeconds === 'number' && typeof previous?.cpuTimeSeconds === 'number'
          const cpu = canComputeDelta
            ? Math.max(0, ((row.cpuTimeSeconds - previous.cpuTimeSeconds) / elapsedSeconds) * 100)
            : row.percentCpu
          return { ...row, cpu }
        })
        samples.push({
          at: sampledAt,
          elapsedMs: sampledAt - previousSnapshot.at,
          totalCpuPercent: processes.reduce((sum, proc) => sum + proc.cpu, 0),
          totalRssBytes: processes.reduce((sum, proc) => sum + proc.rssBytes, 0),
          processes
        })
      }
      previousSnapshot = { at: sampledAt, processes: rawProcesses }
      await sleep(options.intervalMs)
    }
    const report = {
      benchmark: 'orca-idle-cpu',
      createdAt: new Date().toISOString(),
      options,
      rootPid,
      platform: { platform: process.platform, arch: process.arch, cpus: os.cpus().length },
      rendererIdleState,
      sampleCount: samples.length,
      summary: summarizeSamples(samples),
      processInventory: summarizeProcessInventory(samples),
      samples
    }
    if (options.output) {
      mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
      writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`)
      console.log(`[idle-cpu] wrote ${options.output}`)
    }
    console.log(
      JSON.stringify(
        {
          summary: report.summary,
          processInventory: report.processInventory,
          sampleCount: report.sampleCount
        },
        null,
        2
      )
    )
  } finally {
    const launchedProcesses = descendantsOf(readProcessRows(), rootPid).filter(
      (proc) => proc.pid !== rootPid
    )
    await app.close().catch(() => undefined)
    await sleep(250)
    terminateProcesses(launchedProcesses)
    rmSync(userDataDir, { recursive: true, force: true })
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
