import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
import type { RestTestRig } from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import type { AiVaultPrepareSessionResumeResult } from '../../../../shared/ai-vault-resume-preparation'

/** A saved Codex conversation whose CLI transcript the switch reads, for the host's first chat. */
export async function savedTranscript(rig: RestTestRig, sessionId = id) {
  await rig.host.switchToChat(sessionId)
  await rig.host.switchToTerminal(sessionId)
  const record = rig.store.getRecord(sessionId)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const codexHome = join(rig.root, 'codex-account')
  const sessions = join(codexHome, 'sessions')
  await mkdir(sessions, { recursive: true })
  const filePath = join(sessions, 'switch-source.jsonl')
  const nativeId = head.handle.nativeId
  await writeFile(
    filePath,
    `${[
      { type: 'session_meta', payload: { id: nativeId } },
      {
        timestamp: '2026-10-26T12:00:00Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'cli-turn' }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'A terminal prompt'
        }
      },
      {
        timestamp: '2026-10-26T12:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'cli-turn' }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockResolvedValue({
    host: rig.host,
    record,
    head,
    agent: 'codex',
    cwd: rig.root,
    providerSessionId: nativeId,
    requireCurrent: vi.fn(),
    metadata: structuredAgentRuntimeMetadata('codex')!
  })
  const readable: AiVaultPrepareSessionResumeResult = {
    useRealCodexHome: false,
    cliForkSource: {
      agent: 'codex',
      sourceAgent: 'codex',
      sessionId: nativeId,
      filePath,
      cwd: rig.root,
      codexHome,
      executionHostPlatform: process.platform
    }
  }
  vi.spyOn(cliTranscript, 'prepareStructuredChatCliTranscript').mockResolvedValue(readable)
  return readable
}

/** A whole-tab terminal→chat switch whose stop keeps the pane for the replace; records main's settlements. */
export async function switchFromKeptTerminal(options: KeptTerminalSwitchOptions = {}) {
  const started = startSwitchFromKeptTerminal(options)
  return { ...started, result: await started.result }
}

export type KeptTerminalSwitchOptions = {
  beforeStop?: () => Promise<void>
  /** The host was lost before any exit proof: liveness stays unknown. */
  unproven?: boolean
  afterStop?: (runtime: ReturnType<typeof setupMainOwnedWorkspace>['runtime']) => Promise<void>
}

/** A whole-tab terminal whose stop keeps the pane; records main's settlements for it. */
export function keptSourceTerminal(options: KeptTerminalSwitchOptions = {}) {
  const { runtime } = setupMainOwnedWorkspace()
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
  if (!source.presentation) {
    throw new Error('missing captured source')
  }
  const settled = vi.fn()
  runtime.setNotifier({
    settleStoppedSwitchSource: settled,
    closeTerminal: () => {},
    worktreesChanged: () => {},
    reposChanged: () => {},
    activateWorktree: () => {},
    createTerminal: () => {},
    splitTerminal: () => {},
    renameTerminal: () => {},
    focusTerminal: () => {},
    terminalFitOverrideChanged: () => {},
    terminalDriverChanged: () => {}
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    stopAndWait: async () => {
      await options.beforeStop?.()
      if (options.unproven) {
        return false
      }
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      await options.afterStop?.(runtime)
      return true
    },
    getForegroundProcess: async () => null
  })
  const stoppedSource = {
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_A,
    ptyId: PTY_A,
    incarnationId,
    // A switch stopped it, and the stopped pane names the agent.
    switched: { agent: 'codex' as const }
  }
  return {
    runtime,
    source: { ...source, presentation: source.presentation },
    incarnationId,
    settled,
    stoppedSource
  }
}

export function startSwitchFromKeptTerminal(options: KeptTerminalSwitchOptions = {}) {
  const { runtime, source, incarnationId, settled, stoppedSource } = keptSourceTerminal(options)
  const result = executeStructuredSessionSwitch(
    {
      sessionId: id,
      execution: {
        invocationId: 'kept-source',
        source: {
          terminal: source.handle,
          expectedIncarnationId: incarnationId,
          originalPresentation: source.presentation
        }
      }
    },
    { runtime },
    'chat'
  )
  return { result, settled, stoppedSource }
}
