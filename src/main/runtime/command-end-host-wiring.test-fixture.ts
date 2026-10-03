import { expect, vi } from 'vitest'
import type { AgentStatusClearIpcPayload } from '../../shared/agent-status-types'
import type { ShellForegroundProof } from '../providers/shell-foreground-proof'
import { AgentHookServer } from '../agent-hooks/server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import {
  agentHookLaunchAuthorityRuntimeDeps,
  agentHookStatusStoreRuntimeDeps,
  wireRuntimeLaunchAuthorityReader
} from '../agent-hooks/agent-hook-runtime-deps'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

// The host wiring `main-process-runtime-service.ts` performs (through the same builders), plus every
// pane-clear reader, for the command-end specs. Callers must mock `../git/worktree` to list WORKTREE_PATH.

export const WORKTREE_PATH = '/tmp/worktree-a'
export const TEST_WORKTREE_ID = `repo-1::${WORKTREE_PATH}`

export type Readers = {
  windowClears: AgentStatusClearIpcPayload[]
  subscriberClears: AgentStatusClearIpcPayload[]
  republishedWorktrees: string[]
}

export type CommandEndHost = {
  server: AgentHookServer
  runtime: OrcaRuntimeService
  readers: Readers
  spawn: ReturnType<typeof vi.fn>
  /** The execution host's answer on the pane's own shell; reject for a host that can't be reached. */
  shellProof: ReturnType<typeof vi.fn<(ptyId: string) => Promise<ShellForegroundProof>>>
  teardown: () => void
}

export async function wireCommandEndHost(
  options: {
    userDataPath?: string
    server?: AgentHookServer
    /** Replaces the stubbed process answers, e.g. with a real terminal daemon's. */
    controller?: Pick<RuntimePtyController, 'proveShellForeground'>
  } = {}
): Promise<CommandEndHost> {
  const server = options.server ?? new AgentHookServer()
  if (!options.server) {
    await server.start({
      env: 'production',
      ...(options.userDataPath ? { userDataPath: options.userDataPath } : {})
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared fixture store implements only the members these runtime paths read.
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    ...agentHookStatusStoreRuntimeDeps(server),
    ...agentHookLaunchAuthorityRuntimeDeps(server)
  })
  wireRuntimeLaunchAuthorityReader(server, runtime)
  const readers: Readers = { windowClears: [], subscriberClears: [], republishedWorktrees: [] }
  server.setPaneStatusClearListener((clear) => readers.windowClears.push(clear))
  const unsubscribeClears = server.subscribePaneStatusClear((clear) =>
    readers.subscriberClears.push(clear)
  )
  vi.spyOn(runtime, 'touchMobileSessionTabsForWorktree').mockImplementation((worktreeId) => {
    readers.republishedWorktrees.push(worktreeId)
  })
  const uninstallRepublish = installHookStatusSessionTabsRepublish(server, () => runtime)
  const spawn = vi.fn()
  const shellProof = vi.fn<(ptyId: string) => Promise<ShellForegroundProof>>(async () => 'shell')
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    proveShellForeground: (ptyId) => shellProof(ptyId),
    ...options.controller
  })
  return {
    server,
    runtime,
    readers,
    spawn,
    shellProof,
    teardown: () => {
      unsubscribeClears()
      uninstallRepublish()
      server.stop()
    }
  }
}

export async function postHook(
  server: AgentHookServer,
  source: 'claude' | 'codex' | 'opencode',
  pane: { paneKey: string; launchToken?: string },
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: pane.paneKey,
      ...(pane.launchToken ? { launchToken: pane.launchToken } : {}),
      tabId: pane.paneKey.split(':')[0],
      worktreeId: TEST_WORKTREE_ID,
      env: 'production',
      ...extra,
      payload
    })
  })
  expect(response.status).toBe(204)
}

export function liveRow(server: AgentHookServer, paneKey: string) {
  return server
    .getStatusSnapshotForPane(paneKey)
    .find((row) => row.providerSessionOnly !== true && row.paneKey === paneKey)
}

/** An agent Orca launched into a fresh pane: it holds a launch token and a launch agent. */
export async function launchAgentPane(
  host: Pick<CommandEndHost, 'runtime' | 'spawn'>,
  ptyId: string,
  agent: 'claude' | 'codex' | 'opencode' = 'claude',
  incarnationId = `${ptyId}-incarnation`
): Promise<{ ptyId: string; paneKey: string; launchToken: string }> {
  host.spawn.mockResolvedValueOnce({ id: ptyId, incarnationId })
  await host.runtime.createTerminal(`path:${WORKTREE_PATH}`, {
    command: agent,
    launchConfig: { agentCommand: agent, agentArgs: '', agentEnv: {} },
    launchAgent: agent
  })
  const env: Record<string, string> = host.spawn.mock.lastCall?.[0]?.env ?? {}
  expect(env.ORCA_PANE_KEY).toBeTruthy()
  expect(env.ORCA_AGENT_LAUNCH_TOKEN).toBeTruthy()
  return { ptyId, paneKey: env.ORCA_PANE_KEY, launchToken: env.ORCA_AGENT_LAUNCH_TOKEN }
}

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => unknown
  rememberRestoredOrchestrationAuthority: (
    pty: unknown,
    terminalHandle: string,
    incarnationId: string
  ) => void
}

/** A shell pane Orca did not launch an agent into: no launch token, no launch agent, no receipt.
 *  With `listingReceipt`, a restored daemon pane whose only authority is the receipt a listing's
 *  controller-inventory refresh mints for an exactly restored surface. */
export function shellPane(
  runtime: OrcaRuntimeService,
  ptyId: string,
  options: {
    tabId: string
    leafId: string
    listingReceipt?: boolean
    connectionId?: string
    wslDistro?: string
  }
): { ptyId: string; paneKey: string } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these protected members exist on the runtime; the listing path that calls them needs a live controller inventory.
  const internals = runtime as unknown as RuntimeInternals
  const paneKey = `${options.tabId}:${options.leafId}`
  const pty = internals.recordPtyWorktree(ptyId, TEST_WORKTREE_ID, {
    connected: true,
    tabId: options.tabId,
    paneKey,
    incarnationId: `${ptyId}-incarnation`,
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    ...(options.wslDistro ? { isWsl: true, wslDistro: options.wslDistro } : {})
  })
  if (options.listingReceipt) {
    internals.rememberRestoredOrchestrationAuthority(pty, `term-${ptyId}`, `${ptyId}-incarnation`)
  }
  return { ptyId, paneKey }
}

export type CommandEndPath = 'shell bytes' | 'daemon fact'

/** A command end on either path main hears it on, then the verification it starts. */
export async function endCommand(
  runtime: OrcaRuntimeService,
  ptyId: string,
  path: CommandEndPath
): Promise<void> {
  if (path === 'shell bytes') {
    runtime.onPtyData(ptyId, '\x1b]133;D;0\x07', Date.now())
  } else {
    runtime.emitDaemonPtyTransientFact(ptyId, { kind: 'command-finished', exitCode: 0 })
  }
  await settle()
}

export async function settle(ticks = 10): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

export function expectNoReaderLostTheRow(
  server: AgentHookServer,
  readers: Readers,
  paneKey: string,
  state: string
): void {
  expect(liveRow(server, paneKey)?.state).toBe(state)
  expect(readers.windowClears).toEqual([])
  expect(readers.subscriberClears).toEqual([])
}

export function expectEveryReaderSawTheClear(
  server: AgentHookServer,
  readers: Readers,
  paneKey: string
): void {
  expect(liveRow(server, paneKey)).toBeUndefined()
  // Desktop window and dashboard popout share this listener.
  expect(readers.windowClears).toContainEqual({ paneKey })
  // Tab-title spinner and session-stats recorder subscribe here.
  expect(readers.subscriberClears).toContainEqual({ paneKey })
  // Mobile `session.tabs` republish.
  expect(readers.republishedWorktrees).toContain(TEST_WORKTREE_ID)
}
