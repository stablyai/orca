// The four measured windows. Each drives the app the way a user or agent does, then the probes read the counters.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const STREAM_PANES = 10
const STREAM_EVENTS_PER_SECOND = 20
const TYPING_CHARS_PER_SECOND = 10
const SWITCH_INTERVAL_MS = 1_000

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

async function streamAgentStatus({ page, userDataDir, windowMs }) {
  const endpoint = readHookEndpoint(userDataDir)
  if (!endpoint) {
    return { note: 'no agent hook endpoint' }
  }
  const worktreeIds = await page.evaluate((count) => {
    const state = window.__store.getState()
    return Object.values(state.worktreesByRepo)
      .flat()
      .slice(0, count)
      .map((worktree) => worktree.id)
  }, STREAM_PANES)
  if (worktreeIds.length === 0) {
    return { note: 'no workspaces to stream into' }
  }
  const panes = worktreeIds.map((worktreeId, index) => ({
    worktreeId,
    paneKey: `fleet-gate-${index}:${randomUUID()}`,
    step: 0
  }))
  const deadline = Date.now() + windowMs
  let posted = 0
  let failed = 0
  while (Date.now() < deadline) {
    const pane = panes[posted % panes.length]
    const payload = TURN[pane.step % TURN.length]
    pane.step += 1
    try {
      const response = await fetch(
        `http://127.0.0.1:${endpoint.ORCA_AGENT_HOOK_PORT}/hook/claude`,
        {
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
        }
      )
      if (response.status !== 204) {
        failed += 1
      }
    } catch {
      failed += 1
    }
    posted += 1
    await sleep(1_000 / STREAM_EVENTS_PER_SECOND)
  }
  return { note: `${posted} hook events over ${panes.length} panes`, failed }
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
    return (
      visible.tagName.toLowerCase() +
      (visible.className ? `.${String(visible.className).split(' ')[0]}` : '')
    )
  })
  if (!target) {
    return { note: 'no visible input' }
  }
  await page.locator('[data-fleet-gate-input="1"]').first().focus()
  const deadline = Date.now() + windowMs
  let typed = 0
  while (Date.now() < deadline) {
    await page.keyboard.type(typed % 20 === 19 ? ' ' : 'a')
    typed += 1
    await sleep(1_000 / TYPING_CHARS_PER_SECOND)
  }
  // Leave the draft empty so the next window starts from the same state.
  for (let index = 0; index < typed; index += 1) {
    await page.keyboard.press('Backspace')
  }
  return { note: `${typed} keys into ${target}` }
}

async function switchWorkspaces({ page, windowMs }) {
  const pair = await page.evaluate(() => {
    const active = window.__store.getState().activeWorktreeId
    const ids = []
    for (const card of document.querySelectorAll('[data-worktree-id]')) {
      const id = card.getAttribute('data-worktree-id')
      const rect = card.getBoundingClientRect()
      if (id && id !== active && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight) {
        if (!ids.includes(id) && card.querySelector('[data-worktree-card-surface]')) {
          ids.push(id)
        }
      }
    }
    return ids.slice(0, 2)
  })
  if (pair.length < 2) {
    return { note: 'fewer than two visible workspace cards' }
  }
  const deadline = Date.now() + windowMs
  let switches = 0
  let missed = 0
  let firstError = null
  while (Date.now() < deadline) {
    const id = pair[switches % 2]
    try {
      await page
        .locator(`[data-worktree-id="${id}"] [data-worktree-card-surface]`)
        .first()
        .click({ timeout: 5_000 })
    } catch (error) {
      missed += 1
      firstError ??= String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 160)
    }
    switches += 1
    await sleep(SWITCH_INTERVAL_MS)
  }
  return {
    note: `${switches - missed} switches between 2 cards${firstError ? ` (first miss: ${firstError})` : ''}`,
    missed
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
