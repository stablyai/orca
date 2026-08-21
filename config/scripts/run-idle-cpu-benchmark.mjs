#!/usr/bin/env node
import { _electron as electron } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  descendantsOf,
  readProcessRows,
  sampleProcessTreeUntilWorkloadsComplete,
  summarizeProcessInventory,
  summarizeSamples,
  terminateProcesses
} from './idle-cpu-process-sampling.mjs'
import {
  collectRendererCensus,
  configureRendererScaleFixture
} from './idle-cpu-renderer-scale-fixture.mjs'
import {
  runZustandPublications,
  snapshotRendererTimingProbe,
  startRendererTimingProbe,
  stopRendererTimingProbe
} from './idle-cpu-renderer-timing-probe.mjs'
import { installSyntheticVisibleSpinners } from './idle-cpu-synthetic-spinners.mjs'

const DEFAULT_WARMUP_MS = 15_000
const DEFAULT_SAMPLE_MS = 30_000
const DEFAULT_INTERVAL_MS = 1_000
const DEFAULT_WORKTREE_COUNT = 1
const DEFAULT_ZUSTAND_PUBLICATION_INTERVAL_MS = 100
const ONBOARDING_FINAL_STEP = 3
const ONBOARDING_FLOW_VERSION = 2

function parseArgs(argv) {
  const options = {
    warmupMs: DEFAULT_WARMUP_MS,
    sampleMs: DEFAULT_SAMPLE_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    worktrees: DEFAULT_WORKTREE_COUNT,
    lineageDepth: 0,
    agentsPerWorktree: 0,
    zustandPublications: 0,
    zustandPublicationIntervalMs: DEFAULT_ZUSTAND_PUBLICATION_INTERVAL_MS,
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
    } else if (arg === '--lineage-depth') {
      options.lineageDepth = Number(readValue())
    } else if (arg === '--agents-per-worktree') {
      options.agentsPerWorktree = Number(readValue())
    } else if (arg === '--zustand-publications') {
      options.zustandPublications = Number(readValue())
    } else if (arg === '--zustand-publication-interval-ms') {
      options.zustandPublicationIntervalMs = Number(readValue())
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
    'lineageDepth',
    'agentsPerWorktree',
    'zustandPublications',
    'zustandPublicationIntervalMs',
    'syntheticVisibleSpinners',
    'syntheticSpinnerSteps'
  ]) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new Error(`Invalid --${key}: ${options[key]}`)
    }
  }
  options.worktrees = Math.max(1, Math.floor(options.worktrees))
  options.intervalMs = Math.max(250, Math.floor(options.intervalMs))
  options.lineageDepth = Math.floor(options.lineageDepth)
  options.agentsPerWorktree = Math.floor(options.agentsPerWorktree)
  options.zustandPublications = Math.floor(options.zustandPublications)
  options.zustandPublicationIntervalMs = Math.max(
    1,
    Math.floor(options.zustandPublicationIntervalMs)
  )
  options.syntheticVisibleSpinners = Math.max(0, Math.floor(options.syntheticVisibleSpinners))
  options.syntheticSpinnerSteps = Math.max(1, Math.floor(options.syntheticSpinnerSteps))
  if (!['smooth', 'steps'].includes(options.syntheticSpinnerAnimation)) {
    throw new Error(`Invalid --synthetic-spinner-animation: ${options.syntheticSpinnerAnimation}`)
  }
  if (options.lineageDepth > 0 && options.worktrees < 2) {
    throw new Error('--lineage-depth requires at least two --worktrees')
  }
  const publicationSpanMs =
    Math.max(0, options.zustandPublications - 1) * options.zustandPublicationIntervalMs
  if (publicationSpanMs > options.sampleMs) {
    throw new Error(
      `Zustand publication span ${publicationSpanMs}ms exceeds --sample-ms ${options.sampleMs}`
    )
  }
  return options
}
function printUsage() {
  console.log(
    `Usage: node config/scripts/run-idle-cpu-benchmark.mjs [options]\n\nOptions:\n  --warmup-ms <n>    Time to wait after app readiness before sampling (default ${DEFAULT_WARMUP_MS})\n  --sample-ms <n>    Sampling window duration (default ${DEFAULT_SAMPLE_MS})\n  --interval-ms <n>  Sampling cadence (default ${DEFAULT_INTERVAL_MS})\n  --worktrees <n>    Seed repo worktree count, including primary (default ${DEFAULT_WORKTREE_COUNT})\n  --lineage-depth <n>  Nest all worktrees under one expanded lineage, up to this depth\n  --agents-per-worktree <n>  Seed this many visible inline agent rows per worktree\n  --zustand-publications <n>  Publish exactly this many store updates during sampling\n  --zustand-publication-interval-ms <n>  Publication cadence (default ${DEFAULT_ZUSTAND_PUBLICATION_INTERVAL_MS})\n  --headful          Show the Electron window while measuring\n  --skip-build       Reuse out/main/index.js instead of building first\n  --output <path>    Write JSON report to this path\n  --disable-renderer-animations  Inject measurement-only CSS that disables animations/transitions\n  --synthetic-visible-spinners <n>  Measurement-only: add visible working spinners\n  --synthetic-spinner-animation <smooth|steps>  Spinner animation style (default smooth)\n  --synthetic-spinner-steps <n>  Step count for --synthetic-spinner-animation steps (default 12)\n`
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
      ...(options.headful ? { ORCA_E2E_HEADFUL: '1' } : { ORCA_E2E_HEADLESS: '1' })
    }
  })
  const rootPid = app.process().pid
  try {
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 60_000 }
    )
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
    const fixtureState = await page.evaluate(async (repoPath) => {
      const added = await window.api.repos.add({ path: repoPath })
      if ('error' in added) {
        return { error: added.error }
      }
      const store = window.__store
      await store?.getState().fetchRepos()
      const repo = store?.getState().repos.find((candidate) => candidate.id === added.repo.id)
      if (repo) {
        const detected = await store
          .getState()
          .fetchWorktrees(repo.id, { requireAuthoritative: true })
        const importedWorktreePaths = (
          store.getState().detectedWorktreesByRepo[repo.id]?.worktrees ?? []
        )
          .filter((worktree) => !worktree.selectedCheckout)
          .map((worktree) => worktree.path)
        const updated = await store.getState().updateRepo(repo.id, {
          externalWorktreeVisibility: 'show',
          importedExternalWorktreePaths: importedWorktreePaths,
          externalWorktreeInboxBaselinePaths: importedWorktreePaths
        })
        const refreshed = await store
          .getState()
          .fetchWorktrees(repo.id, { requireAuthoritative: true })
        return {
          detected,
          updated,
          refreshed,
          detectedCount: store.getState().detectedWorktreesByRepo[repo.id]?.worktrees.length ?? 0,
          importedCount: importedWorktreePaths.length,
          visibleCount: store.getState().worktreesByRepo[repo.id]?.length ?? 0
        }
      }
      return { error: 'repo-not-found' }
    }, repoDir)
    console.log(`[idle-cpu] fixture ${JSON.stringify(fixtureState)}`)
    await page.waitForFunction(
      (expectedWorktrees) => {
        const state = window.__store?.getState()
        return (
          state?.workspaceSessionReady === true &&
          Object.values(state.worktreesByRepo).flat().length === expectedWorktrees
        )
      },
      options.worktrees,
      { timeout: 180_000 }
    )
    const scaleFixtureState = await configureRendererScaleFixture(page, options, repoDir)
    if (scaleFixtureState.applied) {
      console.log(`[idle-cpu] scale fixture ${JSON.stringify(scaleFixtureState)}`)
    }
    await page.waitForFunction(
      (expectedAgentRows) => {
        const state = window.__store?.getState()
        return (
          state !== undefined &&
          Object.keys(state.agentStatusByPaneKey ?? {}).length >= expectedAgentRows
        )
      },
      scaleFixtureState.seededAgentRows,
      { timeout: 30_000 }
    )
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-worktree-sidebar] [data-worktree-id]')),
      null,
      { timeout: 30_000 }
    )
    console.log(
      `[idle-cpu] root pid=${rootPid}; warmup=${options.warmupMs}ms sample=${options.sampleMs}ms interval=${options.intervalMs}ms worktrees=${options.worktrees} lineage-depth=${options.lineageDepth} agents/worktree=${options.agentsPerWorktree} publications=${options.zustandPublications}`
    )
    await startRendererTimingProbe(page)
    await sleep(options.warmupMs)
    const rendererIdleState = await collectRendererIdleState(page)
    const rendererCensusBefore = await collectRendererCensus(page, options.lineageDepth)
    const rendererTimingBefore = await snapshotRendererTimingProbe(page)
    const publicationPromise = runZustandPublications(
      page,
      options.zustandPublications,
      options.zustandPublicationIntervalMs
    )
    const sampled = await sampleProcessTreeUntilWorkloadsComplete({
      rootPid,
      requestedDurationMs: options.sampleMs,
      intervalMs: options.intervalMs,
      workloadPromise: publicationPromise
    })
    const samples = sampled.samples
    const zustandPublications = sampled.workloadResult
    const rendererTimingAfter = await stopRendererTimingProbe(page)
    const rendererCensusAfter = await collectRendererCensus(page, options.lineageDepth)
    const report = {
      benchmark: 'orca-idle-cpu',
      createdAt: new Date().toISOString(),
      options,
      rootPid,
      platform: { platform: process.platform, arch: process.arch, cpus: os.cpus().length },
      fixtureState,
      scaleFixtureState,
      rendererIdleState,
      rendererCensusBefore,
      rendererCensusAfter,
      rendererTiming: { before: rendererTimingBefore, after: rendererTimingAfter },
      zustandPublications,
      samplingWindow: sampled.samplingWindow,
      sampleCount: samples.length,
      summary: summarizeSamples(samples),
      processInventory: summarizeProcessInventory(samples),
      samples
    }
    if (options.output) {
      mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
      writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`)
      console.log(`[idle-cpu] wrote ${String(options.output)}`)
    }
    console.log(
      JSON.stringify(
        {
          summary: report.summary,
          processInventory: report.processInventory,
          sampleCount: report.sampleCount,
          scaleFixtureState: report.scaleFixtureState,
          rendererCensusBefore: report.rendererCensusBefore,
          rendererCensusAfter: report.rendererCensusAfter,
          rendererTiming: report.rendererTiming,
          zustandPublications: report.zustandPublications,
          samplingWindow: report.samplingWindow
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
