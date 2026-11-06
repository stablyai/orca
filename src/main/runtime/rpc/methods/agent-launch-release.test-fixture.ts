/** The prepared-launch protocol as a desktop caller drives it, and the real chat host behind it.
 *  Each test file mocks its own chat create before importing this. */

import { readdir } from 'node:fs/promises'
import { vi } from 'vitest'
import type { SetupRun } from '../../setup/setup-run'
import type * as StructuredCreate from './structured-agent-session-create'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { AGENT_LAUNCH_ACCEPT_METHODS } from './agent-launch-accept'
import { AGENT_LAUNCH_RELEASE_METHODS } from './agent-launch-release'
import { STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS } from './structured-agent-session-attachments'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStubOptions
} from './agent-launch.test-fixture'

export const ACCEPT = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchAccept')
export const STATUS = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchStatus')
export const PREPARE = methodNamed(AGENT_LAUNCH_RELEASE_METHODS, 'agent.launchPrepare')
export const RELEASE = methodNamed(AGENT_LAUNCH_RELEASE_METHODS, 'agent.launchRelease')

export const SESSION_ID = 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
export const MESSAGE_ID = 'message-3f2504e0'
export const HELD_MESSAGE = 'fix the failing test'
export const DESKTOP: Partial<RpcContext> = {
  clientId: 'desktop-renderer',
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
}
export const DESKTOP_KEY = 'trusted-local:desktop'
export const FIRST_MESSAGE = {
  clientMessageId: MESSAGE_ID,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: HELD_MESSAGE }] }
} as const
export const PICKED = {
  options: { permissionMode: 'ask', model: 'opus', effort: 'high' },
  optionsMode: 'replace-model-selection',
  selection: { model: 'opus', effort: 'high' },
  firstMessage: FIRST_MESSAGE
} as const

export function operationId(index = 0): string {
  return `${Date.now()}-${index.toString(16).padStart(32, '0')}`
}

export function prepared(id: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: 'claude',
    operationId: id,
    target: { kind: 'existing', worktree: 'id:wt-7' },
    sessionId: SESSION_ID,
    nativeChatDefault: true,
    prompt: { delivery: 'submit', clientMessageId: MESSAGE_ID },
    terminalAlternative: { kind: 'agent', prompt: 'submit' },
    setupReceipt: { required: false },
    ...overrides
  }
}

export function hostRuntime(run?: SetupRun, options: AgentLaunchRuntimeStubOptions = {}) {
  return Object.assign(runtimeStub(options), {
    getSetupRun: vi.fn((_worktreeId: string) => run),
    pasteStartupDraftWhenReady: vi.fn((_handle: string, _draft: unknown) => {}),
    deliverStartupFollowup: vi.fn(
      async (_handle: string, _followup: unknown, _options?: unknown) => true
    ),
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}
export type HostRuntime = ReturnType<typeof hostRuntime>

export function prepare(runtime: HostRuntime, params: unknown) {
  return PREPARE.handler(PREPARE.params.parse(params), rpcContext(runtime, DESKTOP))
}

export function release(
  runtime: HostRuntime,
  id: string,
  input: Record<string, unknown> = PICKED,
  caller: Partial<RpcContext> = DESKTOP
) {
  return RELEASE.handler(
    RELEASE.params.parse({ operationId: id, ...input }),
    rpcContext(runtime, caller)
  )
}

export function status(runtime: HostRuntime, id: string, read: Record<string, unknown> = {}) {
  return STATUS.handler(
    STATUS.params.parse({ operationId: id, ...read }),
    rpcContext(runtime, DESKTOP)
  )
}

/** Reads as the releasing caller does until the launch says it waits for its input. */
export async function untilAwaitingRelease(runtime: HostRuntime, id: string): Promise<void> {
  for (let read = 0; read < 100; read += 1) {
    const answer = await status(runtime, id, { includeReleasePhase: true })
    if (answer.state === 'awaiting-release') {
      return
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('the prepared launch never became ready for its input')
}

/** The real chat host and attachment store behind a launch runtime: the founding, its message
 *  transaction and the upload store are production; only the provider adapter is a test double. */
export async function realChatHost() {
  const { createRestTestRig } =
    await import('../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig')
  const { setStructuredAgentSessionHost } =
    await import('../../../native-chat/agent-session-wire/structured-agent-session-registry')
  const actual = await vi.importActual<typeof StructuredCreate>('./structured-agent-session-create')
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  rig.clock.now = Date.now()
  setStructuredAgentSessionHost(rig.host)
  const attachments = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(rig.root), {
    hasSession: (id) => rig.store.getRecord(id) !== null
  })
  setAgentSessionAttachmentStore(attachments)
  const sessionId = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
  const runtime = Object.assign(hostRuntime(), {
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (args: { envelope: unknown }) => ({
      envelope: args.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'wt-7',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      options: { model: 'gpt-5.6-sol', effort: 'medium' },
      runtimeKind: 'native'
    })),
    publishStructuredAgentSessionTab: vi.fn(async () => {})
  })
  return {
    /** The production create, for a test's mocked create to run once. */
    create: actual.createStructuredAgentSessionForWorktree,
    rig,
    runtime,
    sessionId,
    attachments,
    dispose: async () => {
      attachments.clearInFlightForTests()
      setAgentSessionAttachmentStore(null)
      setStructuredAgentSessionHost(null)
      await rig.dispose()
    }
  }
}

export type RealChatHost = Awaited<ReturnType<typeof realChatHost>>

/** Puts client bytes in the host's store as a paired client does, through the RPC methods. */
export async function uploadUnder(
  host: RealChatHost,
  start: { sessionId: string; launchOperationId?: string },
  name: string,
  text: string,
  caller: Partial<RpcContext> = DESKTOP
): Promise<{ uploadId: string; commit: () => Promise<string> }> {
  const methods = STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS
  const context = rpcContext(host.runtime, caller)
  const bytes = Buffer.from(text)
  const begin = methodNamed(methods, 'agentSessionAttachment.uploadStart')
  const append = methodNamed(methods, 'agentSessionAttachment.uploadAppend')
  const commit = methodNamed(methods, 'agentSessionAttachment.uploadCommit')
  const { uploadId } = await begin.handler(
    begin.params.parse({ ...start, name, byteLength: bytes.byteLength }),
    context
  )
  await append.handler(
    append.params.parse({ uploadId, offset: 0, contentBase64: bytes.toString('base64') }),
    context
  )
  return {
    uploadId,
    commit: async () => (await commit.handler(commit.params.parse({ uploadId }), context)).path
  }
}

export function storedUploads(host: RealChatHost): Promise<string[]> {
  return readdir(agentSessionAttachmentStoreRoot(host.rig.root)).catch(() => [])
}

export function claimedUploads(root: string, sessionId: string): string[] {
  return openTestJournalHostDatabase(root)
    .db.prepare('SELECT upload_id FROM agent_session_attachment_claims WHERE session_id = ?')
    .all(sessionId)
    .flatMap((row) =>
      typeof row === 'object' && row !== null && 'upload_id' in row ? [String(row.upload_id)] : []
    )
    .sort()
}
