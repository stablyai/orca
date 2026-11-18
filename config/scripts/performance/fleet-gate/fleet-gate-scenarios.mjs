// The four measured windows. Each drives the app the way a user or agent does, then the probes read the counters.
import fs from 'node:fs'
import path from 'node:path'

const STREAM_PANES = 10
const STREAM_EVENTS_PER_SECOND = 20
const TYPING_CHARS_PER_SECOND = 10
const SWITCH_INTERVAL_MS = 1_000
// A window whose workload mostly didn't happen measures nothing; above this share missed, the run is incomplete.
const MAX_MISSED_SHARE = 0.2

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function findHookEndpoint(root) {
  if (!fs.existsSync(root)) {
    return null
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && (entry.name === 'endpoint.env' || entry.name === 'endpoint.cmd')) {
      return full
    }
    if (entry.isDirectory()) {
      const nested = findHookEndpoint(full)
      if (nested) {
        return nested
      }
    }
  }
  return null
}

function readHookEndpoint(userDataDir) {
  const file = findHookEndpoint(path.join(userDataDir, 'agent-hooks'))
  if (!file) {
    return null
  }
  const values = Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^set\s+/i, ''))
      .filter(Boolean)
      .map((line) => {
        const [key, ...rest] = line.split('=')
        return [key, rest.join('=')]
      })
  )
  return values.ORCA_AGENT_HOOK_PORT ? values : null
}

// One agent turn as Claude's hook script reports it.
const TURN = [
  { hook_event_name: 'UserPromptSubmit', prompt: 'fleet gate turn' },
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
  { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
  { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } },
  { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } },
  { hook_event_name: 'Stop', last_assistant_message: 'done' }
]

/** Real terminal panes (tab + its layout leaf), so hook statuses bind to tabs the way a running agent's do. */
async function terminalPanes(page, count, onePerWorkspace = false) {
  return page.evaluate(
    ({ limit, distinct }) => {
      const state = window.__store.getState()
      const panes = []
      for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
        for (const tab of Array.isArray(tabs) ? tabs : []) {
          const leafId = state.terminalLayoutsByTabId?.[tab.id]?.activeLeafId
          const taken = distinct && panes.some((pane) => pane.worktreeId === worktreeId)
          if (leafId && !taken && panes.length < limit) {
            panes.push({ worktreeId, paneKey: `${tab.id}:${leafId}` })
          }
        }
      }
      return panes
    },
    { limit: count, distinct: onePerWorkspace }
  )
}

async function postHook(endpoint, pane, payload) {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': endpoint.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey: pane.paneKey,
        tabId: pane.paneKey.split(':')[0],
        worktreeId: pane.worktreeId,
        env: endpoint.ORCA_AGENT_HOOK_ENV,
        version: endpoint.ORCA_AGENT_HOOK_VERSION,
        payload: { session_id: `fleet-gate-${pane.paneKey}`, ...payload }
      })
    })
    return response.status === 204
  } catch {
    return false
  }
}

/**
 * Setup, not measured: answer the worktree-cards intro and keep classic cards. Builds that have the intro (#43028)
 * otherwise preview the new cards on a profile that never answered it, so OLD and NEW would click different things.
 */
export async function pinClassicWorktreeCards(page) {
  return page.evaluate(async () => {
    const state = window.__store.getState()
    state.markWorktreeCardsIntroNoticeSeen?.()
    // null is what the intro's own dismiss sets; 'classic' would keep the note open as a preview.
    state.setWorktreeCardsIntroChoice?.(null)
    if (state.settings?.experimentalNewWorktreeCardStyle) {
      await state.updateSettings({ experimentalNewWorktreeCardStyle: false })
    }
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)))
    const after = window.__store.getState()
    if (document.querySelector('[data-worktree-cards-intro]')) {
      return 'intro still open'
    }
    return after.worktreeCardsIntroChoice === 'new' ||
      after.settings?.experimentalNewWorktreeCardStyle === true
      ? 'new cards'
      : 'classic'
  })
}

/** Setup, not measured: one finished agent turn on every seeded terminal, like a fleet of idle agents. */
export async function seedAgentStatuses({ page, userDataDir, count }) {
  const endpoint = readHookEndpoint(userDataDir)
  if (!endpoint) {
    return { panes: 0, note: 'no agent hook endpoint' }
  }
  const panes = await terminalPanes(page, count)
  let failed = 0
  for (const pane of panes) {
    for (const payload of [TURN[0], TURN.at(-1)]) {
      if (!(await postHook(endpoint, pane, payload))) {
        failed += 1
      }
    }
  }
  return { panes: panes.length, failed }
}

async function streamAgentStatus({ page, userDataDir, windowMs }) {
  const endpoint = readHookEndpoint(userDataDir)
  if (!endpoint) {
    return { note: 'no agent hook endpoint', undriven: 'no agent hook endpoint' }
  }
  // One pane per workspace: the workload is statuses across ten workspaces, not ten tabs of one.
  const panes = (await terminalPanes(page, STREAM_PANES, true)).map((pane) => ({
    ...pane,
    step: 0
  }))
  if (panes.length < STREAM_PANES) {
    return {
      note: `only ${String(panes.length)} workspaces with a terminal to stream into`,
      undriven: `${String(panes.length)} of ${String(STREAM_PANES)} workspaces with a terminal`
    }
  }
  const started = Date.now()
  const deadline = started + windowMs
  let posted = 0
  let failed = 0
  while (Date.now() < deadline) {
    const pane = panes[posted % panes.length]
    const payload = TURN[pane.step % TURN.length]
    pane.step += 1
    if (!(await postHook(endpoint, pane, payload))) {
      failed += 1
    }
    posted += 1
    // Paced by the clock, so slow hook replies shrink the count (and show as incomplete) instead of hiding.
    await sleep(Math.max(0, started + (posted * 1_000) / STREAM_EVENTS_PER_SECOND - Date.now()))
  }
  const planned = Math.floor((windowMs / 1_000) * STREAM_EVENTS_PER_SECOND)
  const delivered = posted - failed
  return {
    note: `${posted} hook events over ${panes.length} terminal panes`,
    failed,
    undriven:
      delivered < planned * (1 - MAX_MISSED_SHARE)
        ? `${delivered} of ${planned} planned hook events delivered`
        : null
  }
}

// Setup, not measured: show a seeded workspace that has a terminal, so keys take the real PTY round trip.
async function showTerminalWorkspace(page) {
  await page.evaluate(() => {
    const state = window.__store.getState()
    const withTerminal = Object.entries(state.tabsByWorktree ?? {}).find(
      ([, tabs]) => Array.isArray(tabs) && tabs.length > 0
    )
    if (withTerminal && state.activeWorktreeId !== withTerminal[0]) {
      state.setActiveWorktree(withTerminal[0])
    }
  })
  await sleep(3_000)
}

async function typeIntoComposer({ page, windowMs }) {
  await showTerminalWorkspace(page)
  const target = await page.evaluate(() => {
    const visible =
      [...document.querySelectorAll('.xterm-helper-textarea')].find(
        (element) => element.closest('.xterm')?.getClientRects().length
      ) ??
      [...document.querySelectorAll('textarea, [contenteditable="true"]')].find((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
    if (!visible) {
      return null
    }
    visible.setAttribute('data-fleet-gate-input', '1')
    return {
      label:
        visible.tagName.toLowerCase() +
        (visible.className ? `.${String(visible.className).split(' ')[0]}` : ''),
      terminal: visible.classList.contains('xterm-helper-textarea')
    }
  })
  if (!target) {
    return { note: 'no visible input', undriven: 'no visible input' }
  }
  const textLength = () =>
    page.evaluate(() => {
      const element = document.querySelector('[data-fleet-gate-input="1"]')
      return (element?.value ?? element?.textContent ?? '').length
    })
  await page.locator('[data-fleet-gate-input="1"]').first().focus()
  const lengthBefore = await textLength()
  const deadline = Date.now() + windowMs
  let typed = 0
  while (Date.now() < deadline) {
    await page.keyboard.type(typed % 20 === 19 ? ' ' : 'a')
    typed += 1
    await sleep(1_000 / TYPING_CHARS_PER_SECOND)
  }
  const grew = (await textLength()) - lengthBefore
  // Leave the draft empty so the next window starts from the same state.
  for (let index = 0; index < typed; index += 1) {
    await page.keyboard.press('Backspace')
  }
  const enough = typed * (1 - MAX_MISSED_SHARE)
  // Receipts: a terminal's keys reach main as pty:write (checked by the runner); a composer's land in its text.
  return {
    note: `${String(typed)} keys into ${target.label}`,
    ptyWritesNeeded: target.terminal ? Math.ceil(enough) : 0,
    undriven:
      !target.terminal && grew < enough
        ? `${String(grew)} of ${String(typed)} typed keys reached the input`
        : null
  }
}

// Same check as the workspace-switch paint benchmark: a full-window fixed layer above z 40 swallows card clicks.
// One cheap check per click (a full-page scan per click costs ~1 s at fleet scale and lands in the window):
// closes the setup-script tip, which floats over the workspace list, then hit-tests the target card's centre.
async function clearPathTo(page, id) {
  return page.evaluate((target) => {
    const layer = document.querySelector('[data-setup-script-prompt-layer]')
    const dismiss =
      layer?.querySelector('button[aria-label^="Dismiss"]') ?? layer?.querySelector('button')
    if (dismiss) {
      dismiss.click()
      return { path: 'tip' }
    }
    // The title, not the card centre: what sits at the centre differs by card style (e.g. an agent row).
    const card = target
      ? document.querySelector(`[data-worktree-id="${CSS.escape(target)}"]`)
      : null
    const surface =
      card?.querySelector('[data-worktree-title-inline-rename]') ??
      card?.querySelector('[data-worktree-card-surface]')
    const box = surface?.getBoundingClientRect()
    if (!box) {
      return { path: 'clear' }
    }
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const hit = document.elementFromPoint(x, y)
    return hit && surface.contains(hit) ? { path: 'clear', x, y } : { path: 'covered' }
  }, id)
}

// Once per window: full-window layers and fixed notices close on Escape.
async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const blocked = await page.evaluate(() =>
      [...document.querySelectorAll('body *')].some((element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width < innerWidth * 0.9 || rect.height < innerHeight * 0.9) {
          return false
        }
        const style = getComputedStyle(element)
        return (
          style.position === 'fixed' && style.pointerEvents !== 'none' && Number(style.zIndex) >= 40
        )
      })
    )
    // Status notices (e.g. a changed-display card) sit over the sidebar too and close on Escape.
    const notice = await page.evaluate(() =>
      [...document.querySelectorAll('[role="status"]')].some(
        (element) =>
          getComputedStyle(element).position === 'fixed' && element.getClientRects().length > 0
      )
    )
    const tipClosed = (await clearPathTo(page, null)).path === 'tip'
    if (!blocked && !notice && !tipClosed) {
      return
    }
    if (blocked || notice) {
      await page.keyboard.press('Escape')
    }
    await sleep(200)
  }
}

// Two workspace cards whose centres a tip or notice doesn't cover: the click must land on the card itself.
function uncoveredCardPair(page) {
  return page.evaluate(() => {
    const active = window.__store.getState().activeWorktreeId
    const ids = []
    for (const card of document.querySelectorAll('[data-worktree-id]')) {
      const id = card.getAttribute('data-worktree-id')
      const rect = card.getBoundingClientRect()
      if (id && id !== active && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight) {
        const surface =
          card.querySelector('[data-worktree-title-inline-rename]') ??
          card.querySelector('[data-worktree-card-surface]')
        const box = surface?.getBoundingClientRect()
        const hit = box
          ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          : null
        if (!ids.includes(id) && hit && surface.contains(hit)) {
          ids.push(id)
        }
      }
    }
    return ids.slice(0, 2)
  })
}

async function switchWorkspaces({ page, windowMs }) {
  await dismissOverlays(page)
  let pair = await uncoveredCardPair(page)
  if (pair.length < 2) {
    return { note: 'fewer than two visible workspace cards', undriven: 'no two clickable cards' }
  }
  const started = Date.now()
  const deadline = started + windowMs
  let switches = 0
  let missed = 0
  let firstError = null
  const spentMs = { clear: 0, click: 0, confirm: 0 }
  const lap = (phase, since) => {
    spentMs[phase] += Date.now() - since
    return Date.now()
  }
  while (Date.now() < deadline) {
    let id = pair[switches % 2]
    // A click on the card that is already active proves nothing; aim at the other one.
    if (id === (await page.evaluate(() => window.__store.getState().activeWorktreeId))) {
      id = pair[(switches + 1) % 2]
    }
    let landed = false
    let mark = Date.now()
    // Tips and notices appear after a delay, so check before every click, not just the first.
    let spot = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      spot = await clearPathTo(page, id)
      if (spot.path === 'clear') {
        break
      }
      if (spot.path === 'covered') {
        await page.keyboard.press('Escape')
      }
      await sleep(100)
    }
    mark = lap('clear', mark)
    try {
      if (spot.path !== 'clear' || spot.x === undefined) {
        throw new Error(`card ${spot.path === 'covered' ? 'covered' : 'not on screen'}`)
      }
      // A raw pointer click at the hit-tested centre: locator.click's actionability waits cost ~2 s per click here.
      await page.mouse.click(spot.x, spot.y)
      mark = lap('click', mark)
      landed = await page
        .waitForFunction((target) => window.__store.getState().activeWorktreeId === target, id, {
          polling: 100,
          timeout: 2_000
        })
        .then(() => true)
        .catch(() => false)
      lap('confirm', mark)
      firstError ??= landed ? null : 'clicked, but the workspace did not become active'
    } catch (error) {
      const lines = String(error?.message ?? error).split('\n')
      firstError ??= (
        lines.find((line) =>
          /intercepts|not visible|not stable|outside of the viewport|detached|^card /.test(line)
        ) ?? lines[0]
      )
        .trim()
        .slice(0, 200)
    }
    if (!landed) {
      missed += 1
      // A tip can open over the chosen cards mid-window (e.g. the setup-command tip); move to cards it leaves clear.
      const fresh = await uncoveredCardPair(page)
      pair = fresh.length === 2 ? fresh : pair
    }
    switches += 1
    // One click per tick, so a slow click doesn't shrink the workload unnoticed.
    await sleep(Math.max(0, started + switches * SWITCH_INTERVAL_MS - Date.now()))
  }
  const planned = Math.floor(windowMs / SWITCH_INTERVAL_MS)
  const landedCount = switches - missed
  return {
    note: `${landedCount} switches between 2 cards (per switch: ${['clear', 'click', 'confirm'].map((phase) => `${phase} ${String(Math.round(spentMs[phase] / Math.max(1, switches)))} ms`).join(', ')})${firstError ? ` (first miss: ${firstError})` : ''}`,
    missed,
    undriven:
      landedCount < planned * (1 - MAX_MISSED_SHARE)
        ? `${landedCount} of ${planned} planned switches landed`
        : null
  }
}

export const SCENARIOS = {
  idle: async ({ windowMs }) => {
    await sleep(windowMs)
    return { note: 'no input' }
  },
  typing: typeIntoComposer,
  streaming: streamAgentStatus,
  switch: switchWorkspaces
}
