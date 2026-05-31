/* eslint-disable max-lines -- Why: install/status/remove must share the exact
   managed Amp plugin source and ownership marker. Splitting would make the
   emitted plugin bytes drift from the installer checks that protect user
   plugin files from being overwritten. */
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  readTextFileRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'

const AMP_PLUGIN_FILE = 'orca-agent-status.ts'
const AMP_PLUGIN_MARKER = 'Managed by Orca. Do not edit; changes may be overwritten.'

type PluginFileState =
  | { kind: 'absent' }
  | { kind: 'managed'; complete: boolean }
  | { kind: 'unmanaged' }
  | { kind: 'error'; detail: string }

function getPluginPath(): string {
  return join(homedir(), '.config', 'amp', 'plugins', AMP_PLUGIN_FILE)
}

function getRemotePluginPath(remoteHome: string): string {
  const home = remoteHome.replace(/\/$/, '')
  return `${home}/.config/amp/plugins/${AMP_PLUGIN_FILE}`
}

function isManagedPlugin(content: string): boolean {
  return content.includes(AMP_PLUGIN_MARKER)
}

function isCompleteManagedPlugin(content: string): boolean {
  return (
    isManagedPlugin(content) &&
    content.includes('/hook/amp') &&
    content.includes("amp.on('session.start'") &&
    content.includes("amp.on('agent.start'") &&
    content.includes("amp.on('tool.call'") &&
    content.includes("amp.on('tool.result'") &&
    content.includes("amp.on('agent.end'")
  )
}

function readLocalPluginState(pluginPath: string): PluginFileState {
  if (!existsSync(pluginPath)) {
    return { kind: 'absent' }
  }
  try {
    const content = readFileSync(pluginPath, 'utf-8')
    if (!isManagedPlugin(content)) {
      return { kind: 'unmanaged' }
    }
    return { kind: 'managed', complete: isCompleteManagedPlugin(content) }
  } catch (error) {
    return { kind: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

function statusFromState(pluginPath: string, state: PluginFileState): AgentHookInstallStatus {
  switch (state.kind) {
    case 'absent':
      return {
        agent: 'amp',
        state: 'not_installed',
        configPath: pluginPath,
        managedHooksPresent: false,
        detail: null
      }
    case 'managed':
      return {
        agent: 'amp',
        state: state.complete ? 'installed' : 'partial',
        configPath: pluginPath,
        managedHooksPresent: true,
        detail: state.complete ? null : 'Managed Amp plugin is missing required handlers'
      }
    case 'unmanaged':
      return {
        agent: 'amp',
        state: 'partial',
        configPath: pluginPath,
        managedHooksPresent: false,
        detail: 'Amp Orca status plugin exists but is not Orca-managed'
      }
    case 'error':
      return {
        agent: 'amp',
        state: 'error',
        configPath: pluginPath,
        managedHooksPresent: false,
        detail: state.detail
      }
  }
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, 'utf-8') === content) {
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }

  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, filePath)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}

function getAmpPluginSource(): string {
  return [
    "import { readFileSync, statSync } from 'fs'",
    "import type { PluginAPI } from '@ampcode/plugin'",
    '',
    `// ${AMP_PLUGIN_MARKER}`,
    'type HookCoords = { port?: string; token?: string; env?: string; version?: string }',
    '',
    'let warnedBadEndpoint = false',
    "let cachedEndpointKey = ''",
    'let cachedEndpointValues: HookCoords | null = null',
    '',
    'function readEndpointFile(): HookCoords | null {',
    '  const endpointPath = process.env.ORCA_AGENT_HOOK_ENDPOINT',
    '  if (!endpointPath) return null',
    '  try {',
    '    const stat = statSync(endpointPath)',
    '    const cacheKey = `${stat.mtimeMs}:${stat.size}:${stat.ino}`',
    '    if (cacheKey === cachedEndpointKey && cachedEndpointValues) {',
    '      return cachedEndpointValues',
    '    }',
    "    const contents = readFileSync(endpointPath, 'utf8')",
    '    const out: HookCoords = {}',
    '    for (const line of contents.split(/\\r?\\n/)) {',
    '      const match = line.match(/^(?:set\\s+)?([A-Z0-9_]+)=(.*)$/)',
    '      if (!match) continue',
    '      const value = match[2].replace(/\\r$/, "")',
    "      if (match[1] === 'ORCA_AGENT_HOOK_PORT') out.port = value",
    "      if (match[1] === 'ORCA_AGENT_HOOK_TOKEN') out.token = value",
    "      if (match[1] === 'ORCA_AGENT_HOOK_ENV') out.env = value",
    "      if (match[1] === 'ORCA_AGENT_HOOK_VERSION') out.version = value",
    '    }',
    '    cachedEndpointKey = cacheKey',
    '    cachedEndpointValues = out',
    '    return out',
    '  } catch (error) {',
    "    cachedEndpointKey = ''",
    '    cachedEndpointValues = null',
    '    if ((error as { code?: unknown })?.code !== "ENOENT" && !warnedBadEndpoint) {',
    '      warnedBadEndpoint = true',
    "      console.warn('[orca-hook] failed to parse Amp endpoint file:', (error as Error).message)",
    '    }',
    '    return null',
    '  }',
    '}',
    '',
    'function resolveHookCoords(): HookCoords {',
    '  // Why: Amp sessions can outlive an Orca restart; the endpoint file is',
    '  // rewritten on each start, so read it per event before falling back to env.',
    '  const fileEnv = readEndpointFile() ?? {}',
    '  return {',
    '    port: fileEnv.port || process.env.ORCA_AGENT_HOOK_PORT,',
    '    token: fileEnv.token || process.env.ORCA_AGENT_HOOK_TOKEN,',
    '    env: fileEnv.env || process.env.ORCA_AGENT_HOOK_ENV || "",',
    '    version: fileEnv.version || process.env.ORCA_AGENT_HOOK_VERSION || ""',
    '  }',
    '}',
    '',
    'function previewValue(value: unknown, maxLength = 4000): string | undefined {',
    '  if (typeof value === "string") return value.slice(0, maxLength)',
    '  if (value === null || value === undefined) return undefined',
    '  try {',
    '    return JSON.stringify(value).slice(0, maxLength)',
    '  } catch {',
    '    return String(value).slice(0, maxLength)',
    '  }',
    '}',
    '',
    'function jsonSafe(value: unknown, depth = 0): unknown {',
    '  if (value === null || value === undefined) return value',
    '  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {',
    '    return value',
    '  }',
    '  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {',
    '    return String(value)',
    '  }',
    '  if (depth >= 4) return previewValue(value)',
    '  if (Array.isArray(value)) return value.slice(0, 20).map((item) => jsonSafe(item, depth + 1))',
    '  if (typeof value === "object") {',
    '    const out: Record<string, unknown> = {}',
    '    for (const [key, child] of Object.entries(value).slice(0, 20)) {',
    '      out[key] = jsonSafe(child, depth + 1)',
    '    }',
    '    return out',
    '  }',
    '  return String(value)',
    '}',
    '',
    'async function post(hookEventName: string, payload: Record<string, unknown>): Promise<void> {',
    '  const coords = resolveHookCoords()',
    '  const paneKey = process.env.ORCA_PANE_KEY',
    '  if (!coords.port || !coords.token || !paneKey) return',
    '  const controller = new AbortController()',
    '  const timeout = setTimeout(() => controller.abort(), 1000)',
    '  try {',
    '    await fetch(`http://127.0.0.1:${coords.port}/hook/amp`, {',
    '      method: "POST",',
    '      signal: controller.signal,',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '        "X-Orca-Agent-Hook-Token": coords.token',
    '      },',
    '      body: JSON.stringify({',
    '        paneKey,',
    '        tabId: process.env.ORCA_TAB_ID || "",',
    '        worktreeId: process.env.ORCA_WORKTREE_ID || "",',
    '        env: coords.env,',
    '        version: coords.version,',
    '        hook_event_name: hookEventName,',
    '        payload: { hook_event_name: hookEventName, ...payload }',
    '      })',
    '    })',
    '  } catch {',
    '    // Why: Orca status reporting must never affect the Amp run.',
    '  } finally {',
    '    clearTimeout(timeout)',
    '  }',
    '}',
    '',
    'const MAX_PENDING_POSTS = 50',
    'type QueuedPost = { hookEventName: string; payload: Record<string, unknown> }',
    'let postQueue: QueuedPost[] = []',
    'let postDraining = false',
    '',
    'async function drainPostQueue(): Promise<void> {',
    '  if (postDraining) return',
    '  postDraining = true',
    '  try {',
    '    while (postQueue.length > 0) {',
    '      const next = postQueue.shift()',
    '      if (!next) continue',
    '      await post(next.hookEventName, next.payload)',
    '    }',
    '  } finally {',
    '    postDraining = false',
    '    if (postQueue.length > 0) {',
    '      void drainPostQueue()',
    '    }',
    '  }',
    '}',
    'function enqueuePost(hookEventName: string, payload: Record<string, unknown>): void {',
    '  // Why: keep hook callbacks non-blocking without retaining unbounded',
    '  // payload closures when Orca is down and each POST waits for timeout.',
    '  if (postQueue.length >= MAX_PENDING_POSTS) {',
    '    postQueue.shift()',
    '  }',
    '  postQueue.push({ hookEventName, payload })',
    '  void drainPostQueue()',
    '}',
    '',
    'export default function (amp: PluginAPI) {',
    "  amp.on('session.start', (event) => {",
    '    enqueuePost("session.start", { threadId: event.thread.id })',
    '  })',
    '',
    "  amp.on('agent.start', (event) => {",
    '    enqueuePost("agent.start", {',
    '      threadId: event.thread.id,',
    '      id: event.id,',
    '      message: event.message',
    '    })',
    '  })',
    '',
    "  amp.on('tool.call', (event) => {",
    '    enqueuePost("tool.call", {',
    '      threadId: event.thread.id,',
    '      toolUseId: event.toolUseID,',
    '      tool: event.tool,',
    '      input: jsonSafe(event.input)',
    '    })',
    '    return { action: "allow" }',
    '  })',
    '',
    "  amp.on('tool.result', (event) => {",
    '    enqueuePost("tool.result", {',
    '      threadId: event.thread.id,',
    '      toolUseId: event.toolUseID,',
    '      tool: event.tool,',
    '      input: jsonSafe(event.input),',
    '      status: event.status,',
    '      error: event.error,',
    '      output: previewValue(event.output)',
    '    })',
    '  })',
    '',
    "  amp.on('agent.end', (event) => {",
    '    enqueuePost("agent.end", {',
    '      threadId: event.thread.id,',
    '      id: event.id,',
    '      message: event.message,',
    '      status: event.status',
    '    })',
    '  })',
    '}',
    ''
  ].join('\n')
}

export class AmpHookService {
  getStatus(): AgentHookInstallStatus {
    const pluginPath = getPluginPath()
    return statusFromState(pluginPath, readLocalPluginState(pluginPath))
  }

  install(): AgentHookInstallStatus {
    const pluginPath = getPluginPath()
    const state = readLocalPluginState(pluginPath)
    if (state.kind === 'unmanaged' || state.kind === 'error') {
      return statusFromState(pluginPath, state)
    }
    writeTextFileAtomic(pluginPath, getAmpPluginSource())
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remotePluginPath = getRemotePluginPath(remoteHome)
    try {
      const existing = await readTextFileRemote(sftp, remotePluginPath)
      if (existing !== null && !isManagedPlugin(existing)) {
        return statusFromState(remotePluginPath, { kind: 'unmanaged' })
      }
      await writeTextFileRemoteAtomic(sftp, remotePluginPath, getAmpPluginSource())
      return {
        agent: 'amp',
        state: 'installed',
        configPath: remotePluginPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (error) {
      return {
        agent: 'amp',
        state: 'error',
        configPath: remotePluginPath,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const pluginPath = getPluginPath()
    const state = readLocalPluginState(pluginPath)
    if (state.kind === 'managed') {
      unlinkSync(pluginPath)
      return this.getStatus()
    }
    return statusFromState(pluginPath, state)
  }
}

export const ampHookService = new AmpHookService()

export const _internals = {
  AMP_PLUGIN_FILE,
  AMP_PLUGIN_MARKER,
  getAmpPluginSource,
  getPluginPath,
  getRemotePluginPath,
  isManagedPlugin
}
