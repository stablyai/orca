import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  appShutdownTimeoutMs,
  cdpPollTimeoutMs,
  delay,
  pollUntil,
  rendererActionTimeoutMs,
  runWithTimeout
} from './repro-timing.mjs'
import { createCompletedOnboardingProfile } from './wsl-workspace-fixture.mjs'

const rootDir = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => {
      try {
        server.close()
      } catch {}
      resolve(false)
    })
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

export async function pickFreePort() {
  for (let port = 9533; port < 9633; port += 1) {
    if (await isPortFree(port)) {
      return port
    }
  }
  throw new Error('Could not find a free CDP port in 9533..9632.')
}

export function createGpuUserDataDirectory(gpuMode) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `orca-apphang-${gpuMode}-userdata-`))
  createCompletedOnboardingProfile(userDataDir)
  return userDataDir
}

export function launchDevApp({ cdpPort, userDataDir }) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CODEX_HOME
  delete env.ORCA_CODEX_HOME
  const isolatedHome = path.join(userDataDir, 'home')
  mkdirSync(isolatedHome, { recursive: true })
  Object.assign(env, {
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_ENABLE_STACK_DUMPING: '1',
    NODE_ENV: 'development',
    // Why: this disposable repro profile must not add real-home Codex work to
    // app-hang measurements or expose the developer's Codex state.
    ORCA_DEV_USER_DATA_PATH: userDataDir,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME: '0',
    ORCA_SKIP_DEV_WEB_PREPARE: '1',
    ORCA_STARTUP_DIAGNOSTICS: '1',
    REMOTE_DEBUGGING_PORT: String(cdpPort),
    VITE_EXPOSE_STORE: 'true'
  })
  const child = spawn(
    process.execPath,
    [path.join('config', 'scripts', 'run-electron-vite-dev.mjs')],
    {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  const logs = []
  const collect = (source) => (chunk) => {
    const text = chunk.toString()
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      logs.push({ source, line, at: Date.now() })
      console.log(`[apphang-repro:${source}] ${line}`)
    }
  }
  child.stdout?.on('data', collect('stdout'))
  child.stderr?.on('data', collect('stderr'))
  return { child, logs }
}

export async function stopDevApp(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, appShutdownTimeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.once('exit', () => undefined)
      return
    }
    child.kill('SIGTERM')
  })
}

async function waitForCdp(port) {
  const url = `http://127.0.0.1:${port}/json`
  const startedAt = Date.now()
  while (Date.now() - startedAt < cdpPollTimeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        const targets = await response.json()
        if (Array.isArray(targets) && targets.some((target) => target.type)) {
          return targets
        }
      }
    } catch {}
    await delay(500)
  }
  throw new Error(`Timed out waiting for CDP targets on ${url}`)
}

async function getMainPage(browser) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < cdpPollTimeoutMs) {
    for (const context of browser.contexts()) {
      const pages = context.pages()
      const page =
        pages.find((candidate) =>
          /^https?:\/\/127\.0\.0\.1:|^https?:\/\/localhost:/.test(candidate.url())
        ) ?? pages[0]
      if (page) {
        return page
      }
    }
    await delay(250)
  }
  throw new Error('Timed out waiting for the Electron renderer page.')
}

export async function connectToApp(cdpPort) {
  await waitForCdp(cdpPort)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  const page = await getMainPage(browser)
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
  return { browser, page }
}

export async function installRendererProbe(page) {
  await page.evaluate(() => {
    if (globalThis.__orcaApphangProbe) {
      return
    }
    const probe = {
      intervalMs: 50,
      last: performance.now(),
      maxDriftMs: 0,
      samples: 0,
      startedAt: performance.now(),
      lastTickAt: performance.now()
    }
    const timer = setInterval(() => {
      const now = performance.now()
      const drift = Math.max(0, now - probe.last - probe.intervalMs)
      probe.maxDriftMs = Math.max(probe.maxDriftMs, drift)
      probe.last = now
      probe.lastTickAt = now
      probe.samples += 1
    }, probe.intervalMs)
    globalThis.__orcaApphangProbe = { probe, timer }
  })
}

export async function waitForStoreReady(page) {
  await pollUntil(
    'renderer store exposure',
    () => page.evaluate(() => Boolean(window.__store && window.api)),
    Boolean,
    30_000
  )
  await pollUntil(
    'workspace session hydration',
    () =>
      page.evaluate(() => {
        const state = window.__store?.getState?.()
        return Boolean(state?.workspaceSessionReady && state?.hydrationSucceeded)
      }),
    Boolean,
    45_000
  )
}

export async function collectRendererDiagnostics(page) {
  if (!page) {
    return null
  }
  try {
    return await runWithTimeout(
      'renderer diagnostics',
      () =>
        page.evaluate(async () => {
          const timed = (label, promise) =>
            Promise.race([
              Promise.resolve(promise).then(
                (value) => ({ value }),
                (error) => ({ error: error instanceof Error ? error.message : String(error) })
              ),
              new Promise((resolve) =>
                setTimeout(() => resolve({ error: `Timed out collecting ${label}` }), 1_000)
              )
            ])
          const readWebglIdentity = () => {
            const canvas = document.createElement('canvas')
            let gl = null
            try {
              gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
              if (!gl) {
                return { available: false, vendor: null, renderer: null }
              }
              const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
              if (!debugInfo) {
                return { available: true, vendor: null, renderer: null }
              }
              return {
                available: true,
                vendor: String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '') || null,
                renderer: String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '') || null
              }
            } catch (error) {
              return {
                available: false,
                error: error instanceof Error ? error.message : String(error)
              }
            } finally {
              try {
                gl?.getExtension('WEBGL_lose_context')?.loseContext()
              } catch {}
              canvas.width = 0
              canvas.height = 0
            }
          }
          const allPaneManagersDiagnostics = Array.from(
            window.__paneManagers?.entries?.() ?? []
          ).map(([managerTabId, paneManager]) => ({
            tabId: managerTabId,
            diagnostics: paneManager?.getRenderingDiagnostics?.() ?? []
          }))
          const webglContextCounts = allPaneManagersDiagnostics.reduce(
            (acc, entry) => {
              acc.managerCount += 1
              acc.paneCount += entry.diagnostics.length
              for (const diagnostic of entry.diagnostics) {
                if (diagnostic.hasWebgl) {
                  acc.attachedWebglCount += 1
                }
                if (diagnostic.webglAttachmentDeferred) {
                  acc.deferredWebglCount += 1
                }
              }
              return acc
            },
            { attachedWebglCount: 0, deferredWebglCount: 0, managerCount: 0, paneCount: 0 }
          )
          const state = window.__store?.getState?.()
          const worktreeId = state?.activeWorktreeId ?? null
          const tabId =
            state?.activeTabType === 'terminal'
              ? state.activeTabId
              : worktreeId
                ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
                : null
          const manager = tabId ? window.__paneManagers?.get(tabId) : null
          const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
          const buffer = activePane?.terminal?.buffer?.active ?? null
          return {
            hasStore: Boolean(window.__store),
            workspaceSessionReady: state?.workspaceSessionReady ?? null,
            hydrationSucceeded: state?.hydrationSucceeded ?? null,
            activeView: state?.activeView ?? null,
            activeRepoId: state?.activeRepoId ?? null,
            activeWorktreeId: worktreeId,
            activeTabType: state?.activeTabType ?? null,
            activeTabId: tabId,
            terminalGpuAcceleration: state?.settings?.terminalGpuAcceleration ?? null,
            repoCount: state?.repos?.length ?? null,
            worktreeCountsByRepo: Object.fromEntries(
              Object.entries(state?.worktreesByRepo ?? {}).map(([repoId, worktrees]) => [
                repoId,
                worktrees.length
              ])
            ),
            ptyIdsByTabId: tabId ? (state?.ptyIdsByTabId?.[tabId] ?? []) : [],
            paneManagerCount: window.__paneManagers?.size ?? null,
            activePane: activePane
              ? {
                  id: activePane.id ?? null,
                  leafId: activePane.leafId ?? null,
                  ptyId: activePane.container?.dataset?.ptyId ?? null,
                  cols: activePane.terminal?.cols ?? null,
                  rows: activePane.terminal?.rows ?? null,
                  buffer: buffer
                    ? {
                        baseY: buffer.baseY,
                        viewportY: buffer.viewportY,
                        cursorY: buffer.cursorY,
                        length: buffer.length
                      }
                    : null
                }
              : null,
            renderingDiagnostics: manager?.getRenderingDiagnostics?.() ?? null,
            allPaneManagersDiagnostics,
            webglContextCounts,
            webglIdentity: readWebglIdentity(),
            rendererProbe: globalThis.__orcaApphangProbe?.probe ?? null,
            ptySessions: await timed('PTY sessions', window.api?.pty?.listSessions?.()),
            rendererDeliveryDebug: await timed(
              'renderer delivery debug',
              window.api?.pty?.getRendererDeliveryDebugSnapshot?.()
            )
          }
        }),
      rendererActionTimeoutMs
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
