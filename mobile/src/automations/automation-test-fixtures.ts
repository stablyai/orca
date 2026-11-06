import { getSshTargetIdForExecutionHost } from '../../../src/shared/execution-host'
import { vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { automationSchema, runSchema, setupInventorySchema } from './automation-reply-schema'
import type { AutomationTargets } from './automation-target-inventory'

export function savedAutomation() {
  return automationSchema.parse({
    id: 'automation-1',
    name: 'Review changes',
    prompt: 'Review the latest changes',
    agentId: 'codex',
    projectId: 'repo-1',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    enabled: false,
    timezone: 'America/Los_Angeles',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9',
    dtstart: 1700000000000,
    nextRunAt: 1800000000000,
    baseBranch: 'release',
    reuseSession: true,
    precheck: { command: 'git diff --quiet', timeoutSeconds: 120 },
    extraAgentArgs: '--model saved',
    setupDecision: 'skip',
    missedRunGraceMinutes: 0,
    sourceContext: { kind: 'task-source', projectId: 'provider-project' },
    futureField: 'keep me'
  })
}
export function savedRun(id = 'run-old') {
  return runSchema.parse({
    id,
    automationId: 'automation-1',
    title: 'Review changes',
    status: 'completed',
    trigger: 'schedule',
    scheduledFor: 1700000000000,
    createdAt: 1700000000000,
    startedAt: 1700000000001,
    dispatchedAt: 1700000000002,
    workspaceId: null,
    workspaceDisplayName: 'Removed workspace',
    terminalPaneKey: null,
    terminalPtyId: null,
    error: null,
    precheckResult: null,
    usage: null,
    outputSnapshot: { content: `Output for ${id}`, capturedAt: 1700000000003, truncated: false }
  })
}
export function automationTargets(): AutomationTargets {
  return {
    setups: setupInventorySchema
      .parse({
        setups: [
          {
            id: 'setup-1',
            projectId: 'project-1',
            hostId: 'local',
            repoId: 'repo-1',
            path: '/repo',
            displayName: 'Project',
            setupState: 'ready',
            kind: 'git'
          }
        ]
      })
      .setups.map((setup) => ({ ...setup, label: 'Project', kind: setup.kind })),
    workspaces: [
      {
        worktreeId: 'workspace-1',
        repoId: 'repo-1',
        hostId: 'local',
        displayName: 'Main',
        path: '/repo'
      }
    ],
    coverage: {
      limit: 200,
      totalCount: 1,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    },
    sshTargets: []
  }
}
export function automationRepo(setup = automationTargets().setups[0]!) {
  return {
    id: setup.repoId,
    displayName: setup.displayName,
    path: setup.path,
    executionHostId: setup.hostId,
    connectionId: getSshTargetIdForExecutionHost(setup.hostId)
  }
}
export function automationClient(respond: (method: string, params: unknown) => unknown) {
  let state: ConnectionState = 'connected'
  let generation = 1
  const listeners = new Set<(state: ConnectionState) => void>()
  let events: (event: unknown) => void = () => {}
  const send = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => ({
    id: 'reply',
    ok: true,
    result: await respond(method, params)
  }))
  const client: RpcClient = {
    sendRequest: send,
    subscribe: (_method, _params, listener) => {
      events = listener
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    getGeneration: () => generation,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notifyForeground: () => {},
    close: () => {}
  }
  return {
    client,
    send,
    event: (event: unknown) => events(event),
    state: (next: ConnectionState) => {
      state = next
      generation++
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}
export function deferred<T>() {
  const callbacks = { resolve: (_value: T) => {}, reject: (_reason: unknown) => {} }
  const promise = new Promise<T>((resolve, reject) => {
    callbacks.resolve = resolve
    callbacks.reject = reject
  })
  return { promise, ...callbacks }
}
