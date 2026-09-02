import {
  collectRendererDiagnostics,
  connectToApp,
  createGpuUserDataDirectory,
  installRendererProbe,
  launchDevApp,
  pickFreePort,
  stopDevApp,
  waitForStoreReady
} from './electron-dev-session.mjs'
import { summarizeAppLogs, summarizeTrace } from './apphang-report-summary.mjs'
import {
  activationTimeoutMs,
  pollUntil,
  ptyWaitTimeoutMs,
  rendererActionTimeoutMs,
  runWithTimeout,
  setupTimeoutMs,
  severeActivationMs,
  severeMainIpcMs,
  severePtyWaitMs,
  severeRendererDriftMs,
  terminalMarkerTimeoutMs
} from './repro-timing.mjs'
import { safeRemoveLocalDirectory } from './wsl-workspace-fixture.mjs'

class ReproductionObservedError extends Error {
  constructor(message, evidence) {
    super(message)
    this.name = 'ReproductionObservedError'
    this.evidence = evidence
  }
}

async function setupAppFixture(page, fixture, gpuMode, sourceControl) {
  return await runWithTimeout(
    'fixture registration in Orca',
    () =>
      page.evaluate(
        async ({ repoPath, plainPath, importedWorktreePaths, mode, openSourceControl }) => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is unavailable.')
          }
          const state = store.getState()
          await state.fetchSettings?.()
          await store.getState().updateSettings({ terminalGpuAcceleration: mode })

          const addResult = await window.api.repos.add({ path: repoPath, kind: 'git' })
          if ('error' in addResult) {
            throw new Error(addResult.error)
          }
          await store.getState().fetchRepos()
          let nextState = store.getState()
          const repo =
            nextState.repos.find((candidate) => candidate.path === repoPath) ?? addResult.repo
          await nextState.updateRepo(repo.id, {
            externalWorktreeVisibility: 'show',
            externalWorktreeVisibilityPromptDismissedAt: Date.now(),
            importedExternalWorktreePaths: importedWorktreePaths,
            externalWorktreeInboxBaselinePaths: importedWorktreePaths
          })
          await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })

          const plainRepo = await store.getState().addNonGitFolder(plainPath)
          if (!plainRepo) {
            throw new Error('addNonGitFolder returned null.')
          }
          await store.getState().fetchWorktrees(plainRepo.id, { requireAuthoritative: true })

          nextState = store.getState()
          nextState.setSidebarOpen(true)
          nextState.setGroupBy('none')
          nextState.setSortBy('recent')
          nextState.setShowActiveOnly(false)
          nextState.setActiveView('terminal')
          if (openSourceControl) {
            nextState.setRightSidebarOpen(true)
            nextState.setRightSidebarTab('source-control')
          }

          const gitWorktrees = nextState.worktreesByRepo[repo.id] ?? []
          const plainWorktrees = nextState.worktreesByRepo[plainRepo.id] ?? []
          return {
            repoId: repo.id,
            repoPath: repo.path,
            plainRepoId: plainRepo.id,
            gitWorktrees: gitWorktrees.map((worktree) => ({
              id: worktree.id,
              path: worktree.path,
              displayName: worktree.displayName,
              branch: worktree.branch,
              isMainWorktree: worktree.isMainWorktree
            })),
            plainWorktrees: plainWorktrees.map((worktree) => ({
              id: worktree.id,
              path: worktree.path,
              displayName: worktree.displayName,
              branch: worktree.branch,
              isMainWorktree: worktree.isMainWorktree
            }))
          }
        },
        {
          repoPath: fixture.repoUncPath,
          plainPath: fixture.plainUncPath,
          importedWorktreePaths: fixture.worktreeUncPaths,
          mode: gpuMode,
          openSourceControl: sourceControl
        }
      ),
    setupTimeoutMs
  )
}

async function clickWorktreeCard(page, worktreeId) {
  const rect = await runWithTimeout(
    `locate worktree card ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const rows = Array.from(document.querySelectorAll('[data-worktree-id]'))
        const row = rows.find((candidate) => candidate.getAttribute('data-worktree-id') === id)
        if (!row) {
          return null
        }
        row.scrollIntoView({ block: 'center', inline: 'nearest' })
        const surface = row.querySelector('[data-worktree-card-surface="true"]') ?? row
        const bounds = surface.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) {
          return null
        }
        return {
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
          width: bounds.width,
          height: bounds.height
        }
      }, worktreeId),
    rendererActionTimeoutMs
  )
  if (!rect) {
    throw new Error(`Could not find rendered worktree card for ${worktreeId}`)
  }
  await runWithTimeout(
    `click worktree card ${worktreeId}`,
    () => page.mouse.click(rect.x, rect.y),
    rendererActionTimeoutMs
  )
}

async function waitForActiveWorktree(page, worktreeId) {
  return await pollUntil(
    `active worktree ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState?.()
        return {
          activeWorktreeId: state?.activeWorktreeId ?? null,
          activeTabId: state?.activeTabId ?? null,
          activeTabType: state?.activeTabType ?? null,
          tabs: state?.tabsByWorktree?.[id]?.map((tab) => tab.id) ?? []
        }
      }, worktreeId),
    (value) => value?.activeWorktreeId === worktreeId && value.activeTabType === 'terminal',
    activationTimeoutMs
  )
}

async function waitForActivePty(page, worktreeId) {
  const startedAt = Date.now()
  const value = await pollUntil(
    `active PTY for ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState?.()
        const tabId =
          state?.activeWorktreeId === id && state.activeTabType === 'terminal'
            ? state.activeTabId
            : (state?.activeTabIdByWorktree?.[id] ?? null)
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
        const ptyId = pane?.container?.dataset?.ptyId ?? null
        return {
          tabId,
          ptyId,
          hasManager: Boolean(manager),
          paneCount: manager?.getPanes?.()?.length ?? 0,
          ptyIdsByTab: tabId ? (state?.ptyIdsByTabId?.[tabId] ?? []) : []
        }
      }, worktreeId),
    (value) => Boolean(value?.ptyId),
    ptyWaitTimeoutMs
  )
  return { ...value, waitMs: Date.now() - startedAt }
}

function makeOutputCommand(marker, outputLines) {
  const payload = 'x'.repeat(180)
  return `printf '${marker}_START\\n'; i=1; while [ "$i" -le ${outputLines} ]; do printf '${marker}_%05d ${payload}\\n' "$i"; i=$((i+1)); done; printf '${marker}_DONE\\n'\r`
}

async function getTerminalContent(page, charLimit = 20_000) {
  return await runWithTimeout(
    'terminal content',
    () =>
      page.evaluate((limit) => {
        const state = window.__store?.getState?.()
        const worktreeId = state?.activeWorktreeId
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : worktreeId
              ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
              : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
        return (pane?.serializeAddon?.serialize?.() ?? '').slice(-limit)
      }, charLimit),
    rendererActionTimeoutMs
  )
}

async function sendOutputStress(page, ptyId, marker, outputLines) {
  await runWithTimeout(
    `write terminal stress ${marker}`,
    () =>
      page.evaluate(
        ({ id, command }) => {
          window.api.pty.write(id, command)
        },
        { id: ptyId, command: makeOutputCommand(marker, outputLines) }
      ),
    rendererActionTimeoutMs
  )
  await pollUntil(
    `terminal stress marker ${marker}`,
    async () => (await getTerminalContent(page)).includes(`${marker}_DONE`),
    Boolean,
    terminalMarkerTimeoutMs,
    200
  )
}

async function pingMainIpc(page) {
  const startedAt = Date.now()
  await runWithTimeout(
    'main IPC ping',
    () => page.evaluate(() => window.api.pty.listSessions()),
    rendererActionTimeoutMs
  )
  return Date.now() - startedAt
}

async function readRendererProbe(page) {
  return await runWithTimeout(
    'renderer probe read',
    () => page.evaluate(() => globalThis.__orcaApphangProbe?.probe ?? null),
    rendererActionTimeoutMs
  )
}

async function killActivePty(page) {
  return await runWithTimeout(
    'kill active PTY',
    () =>
      page.evaluate(async () => {
        const state = window.__store?.getState?.()
        const tabId = state?.activeTabId ?? null
        const ptyIds = tabId ? (state?.ptyIdsByTabId?.[tabId] ?? []) : []
        const ptyId = ptyIds[0] ?? null
        if (!ptyId) {
          return null
        }
        await window.api.pty.kill(ptyId)
        return ptyId
      }),
    rendererActionTimeoutMs
  )
}

async function resetRendererProbe(page) {
  // Why: probe drift is cumulative since installation; without a per-cycle
  // reset, one startup/setup stall gets re-reported as a hang in every
  // later cycle's rendererMaxDriftMs check.
  await runWithTimeout(
    'renderer probe reset',
    () =>
      page.evaluate(() => {
        const probe = globalThis.__orcaApphangProbe?.probe
        if (!probe) {
          return
        }
        const now = performance.now()
        probe.last = now
        probe.lastTickAt = now
        probe.startedAt = now
        probe.maxDriftMs = 0
        probe.samples = 0
      }),
    rendererActionTimeoutMs
  )
}

async function runActivationCycle(page, target, args) {
  await resetRendererProbe(page)
  const marker = `ORCA_APPHANG_${target.index}_${Date.now()}`
  const cycleStartedAt = Date.now()
  const activationStartedAt = Date.now()
  await clickWorktreeCard(page, target.id)
  const activation = await waitForActiveWorktree(page, target.id)
  const activationMs = Date.now() - activationStartedAt
  const activePty = await waitForActivePty(page, target.id)
  const diagnosticsBeforeOutput = await collectRendererDiagnostics(page)
  const outputStartedAt = Date.now()
  await sendOutputStress(page, activePty.ptyId, marker, args.outputLines)
  const outputMs = Date.now() - outputStartedAt
  const mainIpcMs = await pingMainIpc(page)
  const rendererProbe = await readRendererProbe(page)
  const diagnosticsAfterOutput = await collectRendererDiagnostics(page)
  const elapsedMs = Date.now() - cycleStartedAt
  const sample = {
    index: target.index,
    kind: target.kind,
    worktreeId: target.id,
    displayName: target.displayName,
    elapsedMs,
    activationMs,
    outputMs,
    activation,
    ptyWaitMs: activePty.waitMs,
    ptyId: activePty.ptyId,
    tabId: activePty.tabId,
    mainIpcMs,
    rendererMaxDriftMs: rendererProbe?.maxDriftMs ?? null,
    renderingDiagnostics: diagnosticsAfterOutput?.renderingDiagnostics ?? null,
    webglIdentity: diagnosticsAfterOutput?.webglIdentity ?? null,
    diagnosticsBeforeOutput,
    diagnosticsAfterOutput
  }

  const reproducedReasons = []
  if (activationMs > severeActivationMs) {
    reproducedReasons.push(`worktree activation took ${activationMs}ms`)
  }
  if (activePty.waitMs > severePtyWaitMs) {
    reproducedReasons.push(`PTY binding took ${activePty.waitMs}ms`)
  }
  if (mainIpcMs > severeMainIpcMs) {
    reproducedReasons.push(`main IPC ping took ${mainIpcMs}ms`)
  }
  if ((rendererProbe?.maxDriftMs ?? 0) > severeRendererDriftMs) {
    reproducedReasons.push(`renderer timer drift reached ${Math.round(rendererProbe.maxDriftMs)}ms`)
  }
  if (reproducedReasons.length > 0) {
    throw new ReproductionObservedError(reproducedReasons.join('; '), sample)
  }
  return sample
}

async function runDeadPtyReactivation(page, targets, args) {
  const samples = []
  for (const target of targets) {
    await clickWorktreeCard(page, target.id)
    await waitForActiveWorktree(page, target.id)
    await waitForActivePty(page, target.id)
    const killedPtyId = await killActivePty(page)
    samples.push({ worktreeId: target.id, killedPtyId })
  }
  for (const target of targets) {
    samples.push(
      await runActivationCycle(page, { ...target, kind: `${target.kind}:dead-pty` }, args)
    )
  }
  return samples
}

function selectTargets(setupResult, cycles) {
  const gitWorktrees = setupResult.gitWorktrees
    .filter((worktree) => worktree.path)
    .sort((a, b) => Number(b.isMainWorktree) - Number(a.isMainWorktree))
    .slice(0, 5)
    .map((worktree) => ({ ...worktree, kind: 'git-wsl' }))
  const plainWorktrees = setupResult.plainWorktrees.map((worktree) => ({
    ...worktree,
    kind: 'plain-folder-wsl'
  }))
  const baseTargets = [...gitWorktrees, ...plainWorktrees]
  if (baseTargets.length === 0) {
    throw new Error('No worktrees were discovered for the repro fixture.')
  }
  return Array.from({ length: cycles }, (_, index) => ({
    ...baseTargets[index % baseTargets.length],
    index: index + 1
  }))
}

export async function runGpuMode(gpuMode, args, fixture) {
  const cdpPort = await pickFreePort()
  const userDataDir = createGpuUserDataDirectory(gpuMode)
  const launched = launchDevApp({ cdpPort, userDataDir })
  let browser = null
  let page = null
  const startedAt = Date.now()
  const result = {
    gpuMode,
    reproduced: false,
    reproductionReason: null,
    harnessError: null,
    startedAt,
    elapsedMs: null,
    cdpPort,
    userDataDir,
    appPid: launched.child.pid ?? null,
    setup: null,
    samples: [],
    finalDiagnostics: null,
    trace: null,
    appLogSummary: null,
    appLogsTail: null,
    cleanupErrors: []
  }

  try {
    const connected = await connectToApp(cdpPort)
    browser = connected.browser
    page = connected.page
    await waitForStoreReady(page)
    await installRendererProbe(page)
    const identity = await runWithTimeout(
      'app identity',
      () => page.evaluate(() => window.api.app.getIdentity?.()),
      rendererActionTimeoutMs
    ).catch(() => null)
    console.log(
      `[apphang-repro] connected gpu=${gpuMode} pid=${result.appPid} identity=${JSON.stringify(identity)}`
    )
    result.setup = await setupAppFixture(page, fixture, gpuMode, args.sourceControl)
    const targets = selectTargets(result.setup, args.cycles)
    console.log(
      `[apphang-repro] targets gpu=${gpuMode}: ${targets
        .map((target) => `${target.kind}:${target.displayName}`)
        .join(', ')}`
    )
    for (const target of targets) {
      console.log(`[apphang-repro] cycle=${target.index} gpu=${gpuMode} kind=${target.kind}`)
      result.samples.push(await runActivationCycle(page, target, args))
    }
    if (args.deadPtyReactivate) {
      const uniqueTargets = []
      const seen = new Set()
      for (const target of targets) {
        if (!seen.has(target.id)) {
          seen.add(target.id)
          uniqueTargets.push(target)
        }
      }
      console.log(`[apphang-repro] dead-pty-reactivation gpu=${gpuMode}`)
      result.samples.push(...(await runDeadPtyReactivation(page, uniqueTargets, args)))
    }
  } catch (error) {
    if (error instanceof ReproductionObservedError) {
      result.reproduced = true
      result.reproductionReason = error.message
      result.samples.push(error.evidence)
    } else {
      // Why: setup/CDP/selector failures are inconclusive, not hang evidence.
      // Conflating them with `reproduced` lets --expect=repro pass on a broken
      // harness; callers treat harnessError as a hard failure instead.
      result.harnessError = error instanceof Error ? error.stack || error.message : String(error)
    }
  } finally {
    result.elapsedMs = Date.now() - startedAt
    result.finalDiagnostics = await collectRendererDiagnostics(page)
    result.trace = summarizeTrace(userDataDir)
    result.appLogSummary = summarizeAppLogs(launched.logs)
    result.appLogsTail = launched.logs.slice(-120)
    if (browser) {
      await browser.close().catch(() => undefined)
    }
    await stopDevApp(launched.child)
    if (!args.keep) {
      safeRemoveLocalDirectory(userDataDir, result.cleanupErrors)
    }
  }
  return result
}
