#!/usr/bin/env node

import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const outMain = path.join(rootDir, 'out', 'main', 'index.js')
const timeoutMs = 45_000
const pollTimeoutMs = 2_500
const appCloseTimeoutMs = 5_000
const typingSamples = 'abcdefghijklmnop'
const gpuCrashPattern =
  /GPU process (?:exited unexpectedly|isn't usable)|gpu_data_manager|exit[_ -]?code=8704/i

class MissingReproductionError extends Error {}

function parseArgs() {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))
  const mode = modeArg?.slice('--mode='.length) ?? 'verify-fix'
  if (mode !== 'verify-fix' && mode !== 'expect-repro') {
    throw new Error(`Unsupported --mode=${mode}`)
  }
  return { mode }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    ...options
  })
}

function assertWaylandHost() {
  if (process.platform !== 'linux') {
    throw new Error('Wayland GPU sandbox validation must run on Linux.')
  }
  if (
    !process.env.WAYLAND_DISPLAY &&
    process.env.XDG_SESSION_TYPE !== 'wayland' &&
    process.env.ELECTRON_OZONE_PLATFORM_HINT !== 'wayland'
  ) {
    throw new Error('Wayland GPU sandbox validation requires a Wayland session.')
  }
}

function ensureElectronRuntime() {
  run(process.execPath, ['config/scripts/ensure-native-runtime.mjs', '--runtime=electron'])
}

function buildAppIfNeeded() {
  if (process.env.SKIP_BUILD === '1' && existsSync(outMain)) {
    console.log('[wayland-gpu] SKIP_BUILD=1 and out/main/index.js exists; skipping build.')
    return
  }
  run('npx', ['electron-vite', 'build', '--mode', 'e2e'])
}

function createGitRepo() {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'orca-wayland-gpu-repo-'))
  run('git', ['init'], { cwd: repoDir, stdio: 'pipe' })
  run('git', ['config', 'user.email', 'wayland-gpu@test.local'], { cwd: repoDir, stdio: 'pipe' })
  run('git', ['config', 'user.name', 'Wayland GPU Test'], { cwd: repoDir, stdio: 'pipe' })
  writeFileSync(path.join(repoDir, 'README.md'), '# Wayland GPU sandbox validation\n')
  writeFileSync(path.join(repoDir, 'package.json'), '{"private":true,"type":"module"}\n')
  run('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' })
  run('git', ['commit', '-m', 'Initial validation fixture'], { cwd: repoDir, stdio: 'pipe' })
  return repoDir
}

function interactivePromptScript(runId) {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdout.write('WAYLAND_TYPING_READY_${runId}\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    process.stdout.write('WAYLAND_TYPED_${runId}_' + seq + ':' + char + '\\n')
  }
})
`
}

async function pollWithTimeout(label, read) {
  const readPromise = Promise.resolve().then(read)
  readPromise.catch(() => undefined)
  // Why: the unfixed Wayland GPU stall can freeze renderer protocol calls, so
  // each poll needs its own deadline instead of relying only on waitFor's loop.
  const result = await Promise.race([
    readPromise.then((value) => ({ timedOut: false, value })),
    delay(pollTimeoutMs).then(() => ({ timedOut: true, value: null }))
  ])
  if (result.timedOut) {
    throw new Error(`Timed out polling ${label} after ${pollTimeoutMs}ms.`)
  }
  return result.value
}

async function waitFor(label, read, timeout = timeoutMs) {
  const startedAt = Date.now()
  let lastValue
  while (Date.now() - startedAt < timeout) {
    lastValue = await pollWithTimeout(label, read)
    if (lastValue) {
      return lastValue
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function closeElectronApp(app) {
  if (!app) {
    return
  }

  const electronProcess = app.process()
  let closeError
  const didClose = await Promise.race([
    app.close().then(
      () => true,
      (error) => {
        closeError = error
        return false
      }
    ),
    delay(appCloseTimeoutMs).then(() => false)
  ])

  if (didClose) {
    return
  }

  if (closeError) {
    console.warn(
      `[wayland-gpu] Electron close failed: ${closeError instanceof Error ? closeError.message : closeError}`
    )
  }
  // Why: reproducing the Wayland GPU stall can wedge Chromium teardown after
  // the evidence is collected, so CI needs a bounded close path.
  if (electronProcess && electronProcess.exitCode === null && electronProcess.signalCode === null) {
    console.warn('[wayland-gpu] Electron did not close cleanly; killing the app process.')
    electronProcess.kill('SIGKILL')
    await Promise.race([
      new Promise((resolve) => electronProcess.once('exit', resolve)),
      delay(appCloseTimeoutMs)
    ])
  }
}

async function getTerminalContent(page, charLimit = 12_000) {
  return page.evaluate((limit) => {
    const store = window.__store
    if (!store || !window.__paneManagers) {
      return ''
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return (pane?.serializeAddon?.serialize?.() ?? '').slice(-limit)
  }, charLimit)
}

async function collectRendererDiagnostics(page) {
  if (!page) {
    return null
  }
  try {
    return await pollWithTimeout('renderer diagnostics', () =>
      page.evaluate(async () => {
        const timed = (label, promise) =>
          Promise.race([
            Promise.resolve(promise).then(
              (value) => ({ value }),
              (error) => ({
                error: error instanceof Error ? error.message : String(error)
              })
            ),
            new Promise((resolve) =>
              setTimeout(() => resolve({ error: `Timed out collecting ${label}` }), 1_000)
            )
          ])
        const rectFor = (element) => {
          if (!(element instanceof Element)) {
            return null
          }
          const rect = element.getBoundingClientRect()
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        }
        const styleFor = (element) => {
          if (!(element instanceof Element)) {
            return null
          }
          const style = getComputedStyle(element)
          return {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity
          }
        }
        const store = window.__store
        const state = store?.getState?.()
        const worktreeId = state?.activeWorktreeId ?? null
        const tabId = state?.activeTabId ?? null
        const tabs = worktreeId ? (state?.tabsByWorktree?.[worktreeId] ?? []) : []
        const activeTab = tabId ? (tabs.find((tab) => tab.id === tabId) ?? null) : null
        const layout = tabId ? (state?.terminalLayoutsByTabId?.[tabId] ?? null) : null
        const tabCount = worktreeId ? (state?.tabsByWorktree?.[worktreeId]?.length ?? 0) : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const activePane = manager?.getActivePane?.() ?? null
        const paneDiagnostics = (manager?.getPanes?.() ?? []).map((pane) => {
          const xtermElement = pane.container?.querySelector?.('.xterm') ?? pane.terminal?.element
          const viewport = pane.container?.querySelector?.('.xterm-viewport') ?? null
          return {
            paneId: pane.id ?? null,
            leafId: pane.leafId ?? null,
            isActive: activePane?.id === pane.id,
            datasetPtyId: pane.container?.dataset?.ptyId ?? null,
            terminalCols: pane.terminal?.cols ?? null,
            terminalRows: pane.terminal?.rows ?? null,
            containerConnected: pane.container?.isConnected ?? null,
            containerRect: rectFor(pane.container),
            containerStyle: styleFor(pane.container),
            xtermRect: rectFor(xtermElement),
            viewportRect: rectFor(viewport),
            viewportScroll: viewport
              ? {
                  scrollTop: viewport.scrollTop,
                  scrollHeight: viewport.scrollHeight,
                  clientHeight: viewport.clientHeight
                }
              : null
          }
        })
        return {
          hasStore: Boolean(store),
          activeWorktreeId: worktreeId,
          activeTabType: state?.activeTabType ?? null,
          activeTabId: tabId,
          tabCount,
          activeTab: activeTab
            ? {
                id: activeTab.id,
                ptyId: activeTab.ptyId ?? null,
                title: activeTab.title ?? null,
                pendingActivationSpawn: activeTab.pendingActivationSpawn ?? null
              }
            : null,
          livePtyIdsForTab: tabId ? (state?.ptyIdsByTabId?.[tabId] ?? null) : null,
          terminalLayout: layout
            ? {
                activeLeafId: layout.activeLeafId ?? null,
                expandedLeafId: layout.expandedLeafId ?? null,
                ptyIdsByLeafId: layout.ptyIdsByLeafId ?? null,
                root: layout.root ?? null
              }
            : null,
          hasPaneManager: Boolean(manager),
          paneDiagnostics,
          renderingDiagnostics: manager?.getRenderingDiagnostics?.() ?? null,
          ptyConnectDiagnostics: globalThis.__ptyConnectDiag ?? null,
          ptySessions: await timed('PTY sessions', window.api?.pty?.listSessions?.()),
          rendererDeliveryDebug: await timed(
            'renderer delivery debug',
            window.api?.pty?.getRendererDeliveryDebugSnapshot?.()
          )
        }
      })
    )
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function sendToTerminal(page, ptyId, text) {
  await page.evaluate(
    ({ ptyId: id, text: input }) => {
      window.api.pty.write(id, input)
    },
    { ptyId, text }
  )
}

async function focusActiveTerminal(page) {
  await page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane to focus.')
    }
    pane.terminal.focus()
    pane.container.querySelector('.xterm-helper-textarea')?.focus()
  })
}

async function setupTerminal(page, repoPath) {
  await waitFor('renderer store exposure', () => page.evaluate(() => Boolean(window.__store)))
  const repoId = await page.evaluate(async (pathToAdd) => {
    const result = await window.api.repos.add({ path: pathToAdd, kind: 'git' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available.')
    }
    await store.getState().fetchRepos()
    await store.getState().fetchWorktrees(result.repo.id, { requireAuthoritative: true })
    return result.repo.id
  }, repoPath)

  await waitFor('active worktree', () =>
    page.evaluate((id) => {
      const store = window.__store
      if (!store) {
        return false
      }
      const state = store.getState()
      const worktree = state.worktreesByRepo[id]?.[0]
      if (!worktree) {
        return false
      }
      state.setActiveWorktree(worktree.id)
      return true
    }, repoId)
  )

  await waitFor('active terminal tab', () =>
    page.evaluate(() => {
      const store = window.__store
      if (!store) {
        return false
      }
      let state = store.getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        return false
      }
      const tabs = state.tabsByWorktree[worktreeId] ?? []
      const tab = tabs[0] ?? state.createTab(worktreeId)
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      state = store.getState()
      return state.activeTabType === 'terminal' && state.activeTabId === tab.id
    })
  )

  return waitFor('active terminal PTY binding', () =>
    page.evaluate(() => {
      const store = window.__store
      const state = store?.getState()
      const tabId = state?.activeTabId
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      return pane?.container?.dataset?.ptyId ?? null
    })
  )
}

async function assertWheelScrollWorks(page, ptyId, runId) {
  await sendToTerminal(
    page,
    ptyId,
    `for i in $(seq 1 160); do echo WAYLAND_SCROLL_${runId}_$i; done\r`
  )
  await waitFor('terminal scrollback marker', async () =>
    (await getTerminalContent(page)).includes(`WAYLAND_SCROLL_${runId}_160`)
  )
  await focusActiveTerminal(page)
  const before = await waitFor('scrollable terminal viewport', () =>
    page.evaluate(() => {
      const viewport = document.querySelector('.xterm-viewport')
      if (!(viewport instanceof HTMLElement)) {
        return null
      }
      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight
      if (maxScrollTop < 40) {
        return null
      }
      viewport.scrollTop = maxScrollTop
      const rect = viewport.getBoundingClientRect()
      return {
        scrollTop: viewport.scrollTop,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      }
    })
  )
  await page.mouse.move(before.x, before.y)
  await page.mouse.wheel(0, -600)
  const after = await waitFor('terminal wheel scroll response', () =>
    page.evaluate((previousScrollTop) => {
      const viewport = document.querySelector('.xterm-viewport')
      if (!(viewport instanceof HTMLElement)) {
        return null
      }
      return viewport.scrollTop < previousScrollTop
        ? { scrollTop: viewport.scrollTop, previousScrollTop }
        : null
    }, before.scrollTop)
  )
  return { beforeScrollTop: before.scrollTop, afterScrollTop: after.scrollTop }
}

async function assertKeyboardInputWorks(page, ptyId, repoPath, runId) {
  const scriptPath = path.join(repoPath, `.orca-wayland-typing-${runId}.mjs`)
  writeFileSync(scriptPath, interactivePromptScript(runId))
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
  await waitFor('interactive prompt readiness', async () =>
    (await getTerminalContent(page)).includes(`WAYLAND_TYPING_READY_${runId}`)
  )
  await focusActiveTerminal(page)
  for (const [index, char] of [...typingSamples].entries()) {
    await page.keyboard.type(char)
    await waitFor(`typed marker ${index + 1}`, async () =>
      (await getTerminalContent(page)).includes(`WAYLAND_TYPED_${runId}_${index + 1}:${char}`)
    )
  }
  await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
  return typingSamples.length
}

async function runValidation(mode) {
  assertWaylandHost()
  ensureElectronRuntime()
  buildAppIfNeeded()

  const repoPath = createGitRepo()
  const userDataPath = mkdtempSync(path.join(tmpdir(), 'orca-wayland-gpu-userdata-'))
  const runId = `${Date.now()}`
  let app
  let page
  let terminalExerciseStarted = false
  let commandLineSwitches = null
  const stderrLines = []

  try {
    const { ELECTRON_RUN_AS_NODE: _unused, DISPLAY: _display, ...env } = process.env
    void _unused
    void _display
    app = await electron.launch({
      args: ['--ozone-platform=wayland', outMain],
      env: {
        ...env,
        NODE_ENV: 'development',
        ORCA_DEV_USER_DATA_PATH: userDataPath,
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_ENABLE_STACK_DUMPING: '1',
        ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
        XDG_SESSION_TYPE: 'wayland'
      }
    })
    app.process().stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderrLines.push(...text.split(/\r?\n/).filter(Boolean))
      if (process.env.ORCA_WAYLAND_GPU_VERBOSE === '1') {
        process.stderr.write(text)
      }
    })

    await app.evaluate(async ({ app: electronApp }) => {
      await electronApp.whenReady()
    })
    commandLineSwitches = await app.evaluate(({ app: electronApp }) => ({
      disableGpuSandbox: electronApp.commandLine.hasSwitch('disable-gpu-sandbox'),
      disableGpu: electronApp.commandLine.hasSwitch('disable-gpu'),
      ozonePlatform: electronApp.commandLine.getSwitchValue('ozone-platform'),
      enableFeatures: electronApp.commandLine.getSwitchValue('enable-features')
    }))

    if (mode === 'expect-repro' && commandLineSwitches.disableGpuSandbox) {
      throw new MissingReproductionError(
        'Base run already has --disable-gpu-sandbox; cannot validate the unfixed Wayland path.'
      )
    }
    if (mode === 'expect-repro' && commandLineSwitches.disableGpu) {
      throw new MissingReproductionError(
        'Base run has --disable-gpu; hardware acceleration is disabled and would mask the GPU sandbox path.'
      )
    }
    if (mode === 'verify-fix' && !commandLineSwitches.disableGpuSandbox) {
      throw new Error('Expected --disable-gpu-sandbox on Linux Wayland, but it was absent.')
    }
    if (mode === 'verify-fix' && commandLineSwitches.disableGpu) {
      throw new Error('Expected hardware acceleration to remain enabled, but --disable-gpu is set.')
    }

    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const ptyId = await setupTerminal(page, repoPath)
    terminalExerciseStarted = true
    const scroll = await assertWheelScrollWorks(page, ptyId, runId)
    const typedMarkers = await assertKeyboardInputWorks(page, ptyId, repoPath, runId)
    const gpuCrashLines = stderrLines.filter((line) => gpuCrashPattern.test(line))

    if (mode === 'expect-repro') {
      throw new MissingReproductionError(
        'Terminal input and scroll stayed responsive without the fix on this host.'
      )
    }
    if (gpuCrashLines.length > 0) {
      throw new Error(`GPU crash evidence appeared in stderr:\n${gpuCrashLines.join('\n')}`)
    }

    console.log(
      JSON.stringify(
        {
          mode,
          waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
          xdgSessionType: process.env.XDG_SESSION_TYPE ?? null,
          switches: commandLineSwitches,
          scroll,
          typedMarkers,
          gpuCrashLines
        },
        null,
        2
      )
    )
  } catch (error) {
    const gpuCrashLines = stderrLines.filter((line) => gpuCrashPattern.test(line))
    const rendererDiagnostics = await collectRendererDiagnostics(page)
    if (
      mode === 'expect-repro' &&
      !(error instanceof MissingReproductionError) &&
      (terminalExerciseStarted || gpuCrashLines.length > 0)
    ) {
      console.log(
        JSON.stringify(
          {
            mode,
            reproduced: true,
            reason: error instanceof Error ? error.message : String(error),
            switches: commandLineSwitches,
            rendererDiagnostics,
            gpuCrashLines
          },
          null,
          2
        )
      )
      return
    }
    console.error(
      JSON.stringify(
        {
          mode,
          reason: error instanceof Error ? error.message : String(error),
          switches: commandLineSwitches,
          rendererDiagnostics,
          gpuCrashLines
        },
        null,
        2
      )
    )
    throw error
  } finally {
    await closeElectronApp(app)
    rmSync(repoPath, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  }
}

const { mode } = parseArgs()
runValidation(mode).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exit(1)
})
