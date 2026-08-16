import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import type { HerdrDaemonModel } from './herdr-daemon-model'
import type { HerdrAgentStatus } from './herdr-runtime-contract'
import type { ModelTab, ModelWorkspace } from './herdr-daemon-model-types'
import { getSessionDir } from './herdr-daemon-helpers'

// Why: soft reattach. The daemon persists the session model + per-pane
// scrollback to the data dir and reloads them on boot so quit+reopen restores
// the layout and prior output. Running processes are NOT resumed; fresh
// shells start in the saved cwds with the saved scrollback prepended.

// Why: dataDir is threaded in explicitly instead of re-reading
// getHerdrDataDir() here. The daemon resolves it once in its constructor; a
// later save must target that same dir even if the env variable changed (for
// example a disposed daemon's pending timer firing after a new session dir was
// selected).

type SavedPane = {
  pane_id: string
  tab_id: string
  workspace_id: string
  cwd: string
  label?: string
  tokens?: Record<string, string>
  agent: string | null
  agent_status: string
  revision: number
  connection_id?: string | null
}

type SessionState = {
  protocol: number
  workspaces: ModelWorkspace[]
  tabs: ModelTab[]
  panes: SavedPane[]
  counters: { workspace: number; tab: number; pane: number }
}

export function getSessionStatePath(dataDir: string, sessionName: string): string {
  return join(getSessionDir(dataDir, sessionName), 'session.json')
}

function getPaneBufferDir(dataDir: string, sessionName: string): string {
  return join(getSessionDir(dataDir, sessionName), 'panes')
}

export function getPaneBufferPath(dataDir: string, sessionName: string, paneId: string): string {
  return join(getPaneBufferDir(dataDir, sessionName), `${paneId}.buffer`)
}

export function saveSession(
  model: HerdrDaemonModel,
  dataDir: string,
  sessionName: string,
  protocol: number,
  paneBuffers: Map<string, string>
): void {
  const sessionDir = getSessionDir(dataDir, sessionName)
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(getPaneBufferDir(dataDir, sessionName), { recursive: true })

  const state: SessionState = {
    protocol,
    workspaces: model.listWorkspaces(),
    tabs: model.listTabs(),
    panes: model.listPanes().map((pane) => ({
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
      cwd: pane.cwd,
      label: pane.label,
      tokens: pane.tokens,
      agent: pane.agent,
      agent_status: pane.agent_status,
      revision: pane.revision,
      connection_id: pane.connection_id ?? null
    })),
    counters: model.getCounters()
  }
  writeFileSync(getSessionStatePath(dataDir, sessionName), JSON.stringify(state))

  for (const [paneId, buffer] of paneBuffers) {
    writeFileSync(getPaneBufferPath(dataDir, sessionName, paneId), buffer)
  }
  pruneStaleBuffers(dataDir, sessionName, new Set(paneBuffers.keys()))
}

function pruneStaleBuffers(dataDir: string, sessionName: string, livePaneIds: Set<string>): void {
  const dir = getPaneBufferDir(dataDir, sessionName)
  if (!existsSync(dir)) {
    return
  }
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.buffer')) {
      continue
    }
    const paneId = entry.slice(0, -'.buffer'.length)
    if (!livePaneIds.has(paneId)) {
      rmSync(join(dir, entry), { force: true })
    }
  }
}

export function loadSession(
  model: HerdrDaemonModel,
  dataDir: string,
  sessionName: string,
  expectedProtocol: number
): { restored: boolean; paneBuffers: Map<string, string> } {
  const statePath = getSessionStatePath(dataDir, sessionName)
  if (!existsSync(statePath)) {
    return { restored: false, paneBuffers: new Map() }
  }

  let state: SessionState
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as SessionState
  } catch {
    return { restored: false, paneBuffers: new Map() }
  }
  if (state.protocol !== expectedProtocol) {
    return { restored: false, paneBuffers: new Map() }
  }

  for (const workspace of state.workspaces ?? []) {
    model.restoreWorkspace(workspace)
  }
  for (const tab of state.tabs ?? []) {
    model.restoreTab(tab)
  }
  for (const pane of state.panes ?? []) {
    model.restorePane({
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
      cwd: pane.cwd,
      label: pane.label,
      tokens: pane.tokens,
      agent: pane.agent,
      agent_status: pane.agent_status as HerdrAgentStatus,
      revision: pane.revision,
      connection_id: pane.connection_id ?? null
    })
  }
  if (state.counters) {
    model.restoreCounters(state.counters.workspace, state.counters.tab, state.counters.pane)
  }

  const paneBuffers = new Map<string, string>()
  for (const pane of state.panes ?? []) {
    const bufferPath = getPaneBufferPath(dataDir, sessionName, pane.pane_id)
    if (existsSync(bufferPath)) {
      try {
        paneBuffers.set(pane.pane_id, readFileSync(bufferPath, 'utf8'))
      } catch {
        // Why: a missing/unreadable buffer leaves the pane with empty scrollback.
      }
    }
  }
  return { restored: true, paneBuffers }
}
