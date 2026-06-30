import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runWithTimeout } from './linux-wayland-validation-watchdog.mjs'

const terminalWaitTimeoutMs = 45_000
const pollTimeoutMs = 2_500
const rendererActionTimeoutMs = 10_000
const rendererSetupTimeoutMs = 30_000
const typingSamples = 'abcdefghijklmnop'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function waitFor(label, read, timeout = terminalWaitTimeoutMs) {
  const startedAt = Date.now()
  let lastValue
  while (Date.now() - startedAt < timeout) {
    lastValue = await pollWithTimeout(label, read)
    if (lastValue) {
      return lastValue
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`)
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

async function sendToTerminal(page, ptyId, text) {
  await runWithTimeout(
    'terminal input write',
    () =>
      page.evaluate(
        ({ ptyId: id, text: input }) => {
          window.api.pty.write(id, input)
        },
        { ptyId, text }
      ),
    rendererActionTimeoutMs
  )
}

async function focusActiveTerminal(page) {
  await runWithTimeout(
    'active terminal focus',
    () =>
      page.evaluate(() => {
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
      }),
    rendererActionTimeoutMs
  )
}

export async function setupTerminal(page, repoPath, logPhase) {
  logPhase('setup.wait-store')
  await waitFor('renderer store exposure', () => page.evaluate(() => Boolean(window.__store)))
  logPhase('setup.wait-hydration')
  await waitFor('workspace session hydration', () =>
    page.evaluate(() => {
      const state = window.__store?.getState?.()
      return Boolean(state?.workspaceSessionReady && state?.hydrationSucceeded)
    })
  )
  logPhase('setup.add-repo')
  const repoId = await runWithTimeout(
    'repo registration',
    () =>
      page.evaluate(async (pathToAdd) => {
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
      }, repoPath),
    rendererSetupTimeoutMs
  )

  // Why: startup hydration can reset activeWorktreeId; after it completes, set
  // worktree, tab, and visible type in one renderer transaction for CI setup.
  logPhase('setup.activate-worktree')
  await waitFor('active terminal workspace setup', () =>
    page.evaluate((id) => {
      const store = window.__store
      if (!store) {
        return false
      }
      let state = store.getState()
      const worktree = state.worktreesByRepo[id]?.[0]
      if (!worktree) {
        return false
      }
      state.setActiveWorktree(worktree.id)
      state = store.getState()
      const tabs = state.tabsByWorktree[worktree.id] ?? []
      const tab =
        tabs[0] ??
        state.createTab(worktree.id, undefined, undefined, {
          activate: true,
          pendingActivationSpawn: true
        })
      state = store.getState()
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      state = store.getState()
      if (
        state.activeWorktreeId !== worktree.id ||
        state.activeTabType !== 'terminal' ||
        state.activeTabId !== tab.id
      ) {
        return false
      }
      return true
    }, repoId)
  )

  logPhase('setup.wait-pty')
  const ptyId = await waitFor('active terminal PTY binding', () =>
    page.evaluate(() => {
      const store = window.__store
      const state = store?.getState()
      const tabId = state?.activeTabId
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      return pane?.container?.dataset?.ptyId ?? null
    })
  )
  logPhase('setup.pty-bound', `ptyId=${ptyId}`)
  return ptyId
}

export async function assertScrollbackBufferWorks(page, ptyId, runId, logPhase) {
  logPhase('scroll.send-start')
  await sendToTerminal(
    page,
    ptyId,
    `for i in $(seq 1 160); do echo WAYLAND_SCROLL_${runId}_$i; done\r`
  )
  logPhase('scroll.send-done')
  await waitFor('terminal scrollback marker', async () =>
    (await getTerminalContent(page)).includes(`WAYLAND_SCROLL_${runId}_160`)
  )
  logPhase('scroll.marker-seen')
  await focusActiveTerminal(page)
  logPhase('scroll.focused')
  const before = await waitFor('scrollable terminal buffer', () =>
    page.evaluate(() => {
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
        return null
      }
      const buffer = pane.terminal.buffer.active
      if (buffer.baseY < 40) {
        return null
      }
      pane.terminal.scrollToBottom()
      if (buffer.viewportY < buffer.baseY - 1) {
        return null
      }
      const target =
        pane.container.querySelector('.xterm-screen') ??
        pane.container.querySelector('.xterm-viewport') ??
        pane.terminal.element ??
        pane.container
      if (!(target instanceof HTMLElement)) {
        return null
      }
      const viewport = pane.container.querySelector('.xterm-viewport')
      const rect = target.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return {
        viewportY: buffer.viewportY,
        baseY: buffer.baseY,
        scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
        screenWidth: rect.width,
        screenHeight: rect.height
      }
    })
  )
  logPhase('scroll.buffer-ready', `baseY=${before.baseY} viewportY=${before.viewportY}`)
  // Why: headless Wayland does not provide a reliable native wheel path in CI,
  // so verify xterm's scrollback buffer can move without bypassing the renderer.
  await runWithTimeout(
    'terminal scrollback API scroll',
    () =>
      page.evaluate(() => {
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
          throw new Error('No active terminal pane for scrollback API scroll.')
        }
        pane.terminal.scrollLines(-10)
      }),
    rendererActionTimeoutMs
  )
  logPhase('scroll.api-scroll-sent')
  const after = await waitFor('terminal scrollback API response', () =>
    page.evaluate((previousViewportY) => {
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
        return null
      }
      const buffer = pane.terminal.buffer.active
      const viewport = pane.container.querySelector('.xterm-viewport')
      return buffer.viewportY < previousViewportY
        ? {
            viewportY: buffer.viewportY,
            previousViewportY,
            baseY: buffer.baseY,
            scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null
          }
        : null
    }, before.viewportY)
  )
  logPhase('scroll.response', `viewportY=${after.viewportY} previous=${after.previousViewportY}`)
  return {
    beforeScrollTop: before.scrollTop,
    afterScrollTop: after.scrollTop,
    beforeViewportY: before.viewportY,
    afterViewportY: after.viewportY,
    baseY: after.baseY,
    screenWidth: before.screenWidth,
    screenHeight: before.screenHeight
  }
}

export async function assertKeyboardInputWorks(page, ptyId, repoPath, runId, logPhase) {
  const scriptPath = path.join(repoPath, `.orca-wayland-typing-${runId}.mjs`)
  writeFileSync(scriptPath, interactivePromptScript(runId))
  logPhase('typing.prompt-send')
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
  await waitFor('interactive prompt readiness', async () =>
    (await getTerminalContent(page)).includes(`WAYLAND_TYPING_READY_${runId}`)
  )
  logPhase('typing.ready')
  await focusActiveTerminal(page)
  for (const [index, char] of [...typingSamples].entries()) {
    logPhase('typing.char', `index=${index + 1}`)
    await runWithTimeout(
      `keyboard type ${index + 1}`,
      () => page.keyboard.type(char),
      rendererActionTimeoutMs
    )
    await waitFor(`typed marker ${index + 1}`, async () =>
      (await getTerminalContent(page)).includes(`WAYLAND_TYPED_${runId}_${index + 1}:${char}`)
    )
  }
  logPhase('typing.complete')
  await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
  return typingSamples.length
}
