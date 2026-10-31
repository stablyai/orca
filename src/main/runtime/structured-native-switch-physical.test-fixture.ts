import { expect, vi } from 'vitest'
import { join } from 'node:path'
import * as cliTranscript from '../ai-vault/structured-chat-cli-fork'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { agentSessionSwitchDeadline } from '../../shared/agent-session-switch-execution'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { structuredAgentRuntimeMetadata } from './structured-agent-runtime-metadata'
import { setupMainOwnedWorkspace } from './main-owned-workspace-runtime-fixture'
import { executeStructuredSessionTerminalSwitch } from './rpc/methods/structured-agent-session-switch-terminal-execution'

/** Real switch/ordinary layout writers, with only provider transcript I/O and terminal spawn external. */
export async function nativeSwitchPhysicalFixture(
  host: StructuredAgentSessionHost,
  sessionId: string,
  directory: string,
  agent: 'claude' | 'codex'
) {
  const record = host.deps.store.getRecord(sessionId)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const { runtime, handleOf } = setupMainOwnedWorkspace()
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async () => ({
      id: record.location.workspaceId,
      path: directory,
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
  })
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: record.location.workspaceId,
    sessionId,
    agent,
    activate: true
  })
  vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockResolvedValue({
    host,
    record,
    head,
    agent,
    cwd: directory,
    providerSessionId: head.handle.nativeId,
    metadata: structuredAgentRuntimeMetadata(agent)!,
    requireCurrent: () => {
      const current = host.deps.store.requireWritableRecord(sessionId)
      expect(current.location).toEqual(record.location)
      expect(agentSessionProviderHandleChainHead(current.providerHandleChain)?.linkId).toBe(
        head.linkId
      )
    }
  })
  vi.spyOn(cliTranscript, 'prepareStructuredChatCliTranscript').mockResolvedValue({
    useRealCodexHome: false,
    cliForkSource: {
      agent,
      sourceAgent: agent,
      sessionId: head.handle.nativeId,
      filePath: join(directory, 'provider-transcript.jsonl'),
      cwd: directory,
      codexHome: null,
      executionHostPlatform: process.platform
    }
  })
  const spawn = vi
    .spyOn(runtime, 'createTerminal')
    .mockImplementation(async (_selector, opts = {}) => {
      // The switch prepares its terminal at rest: a pane identity, no tab until the one replace.
      if (!opts.tabId || !opts.leafId) {
        throw new Error('missing prepared pane identity')
      }
      opts.onPtySpawnDispatched?.({
        launchAgent: agent,
        ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {})
      })
      runtime.registerPty('physical-switch-destination', record.location.workspaceId, null, {
        tabId: opts.tabId,
        leafId: opts.leafId,
        terminalHandle: opts.preAllocatedHandle
      })
      return {
        handle: handleOf('physical-switch-destination'),
        ptyId: 'physical-switch-destination',
        tabId: opts.tabId,
        paneKey: `${opts.tabId}:${opts.leafId}`,
        worktreeId: record.location.workspaceId,
        title: null,
        surface: 'background'
      }
    })
  let invocation = 0
  const deadlines: ReturnType<typeof agentSessionSwitchDeadline>[] = []
  return {
    runtime,
    spawn,
    run: (budget = 120_000) => {
      const deadline = agentSessionSwitchDeadline(() => performance.now(), budget)
      deadlines.push(deadline)
      const execution = {
        invocationId: `exact-source-${++invocation}`,
        sourceTabId: `agent-session:${sessionId}`
      }
      return host.runSwitch(
        sessionId,
        execution.invocationId,
        deadline,
        () =>
          executeStructuredSessionTerminalSwitch(
            { sessionId, execution },
            host.deps.store.getRecord(sessionId)!,
            { runtime },
            host,
            sessionId,
            deadline
          ),
        { direction: 'terminal' }
      )
    },
    dispose: () => deadlines.forEach((deadline) => deadline.dispose())
  }
}
