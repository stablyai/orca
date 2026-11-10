import { Alert, Platform } from 'react-native'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/agent-session-create-capabilities'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../src/shared/orca-session-address'
import { agentReferenceNote } from '../../../src/shared/orchestration/mailbox/orchestration-agent-reference'
import { translate } from '../i18n/mobile-i18n'
import { triggerError } from '../platform/haptics'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../src/shared/agent-session/structured-agent-session-create'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import { slugifyForWorkspaceName } from '../../../src/shared/workspace-name'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { sessionWorktreeRecordRead } from '../worktree/session-worktree-record-operations'
import { createWorktreeWithNameRetry } from '../tasks/worktree-create-retry'
import type { WorktreeCreateIdempotencyProbe } from '../tasks/worktree-create-idempotency-policy'
import { createMobileStructuredAgentSession } from './native-chat/agent-session/mobile-structured-agent-session-launch'

/** A worktree you drive, or a background subagent that reports back to the chat it came from. */
export type MobileWorktreeForkMode = 'worktree' | 'subagent'

/** Whether this phone can ask for a subagent's task: iOS has a text prompt, and the host must take a first message. */
export function mobileSubagentForkAvailable(
  hostCapabilities: readonly string[] | undefined
): boolean {
  return (
    Platform.OS === 'ios' &&
    hostCapabilities?.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY) === true
  )
}

/** Asks for the subagent's task; null when cancelled or empty. */
function askMobileSubagentTask(): Promise<string | null> {
  return new Promise((resolve) => {
    Alert.prompt(
      translate('chat.fork.subagent.title', 'Background subagent'),
      translate(
        'chat.fork.subagent.message',
        'A copy of this chat works on this in its own worktree and reports back here.'
      ),
      [
        {
          text: translate('chat.fork.worktree.cancel', 'Cancel'),
          style: 'cancel',
          onPress: () => resolve(null)
        },
        {
          text: translate('chat.fork.subagent.start', 'Start'),
          onPress: (value?: string) => resolve(value?.trim() || null)
        }
      ],
      'plain-text'
    )
  })
}

/** The subagent's first message: its task, and the chat it reports back to. */
function subagentFirstMessage(task: string, sourceSessionId: string, label: string): string {
  if (!isOrcaSessionId(sourceSessionId)) {
    return task
  }
  const address = formatOrcaSessionAddress(sourceSessionId)
  return `${task}\n\nWork on this on your own. When you are done, report what you did and found to the chat you were forked from.\n${agentReferenceNote(label, address)}`
}

/** Where the fork's new worktree branches from: the project's main branch, or the source's own branch. */
export type MobileWorktreeForkBase = 'main' | 'current'

/** Asks where the new worktree should branch from; main is the default. Null when cancelled. */
export function askMobileWorktreeForkBase(
  branch: string | null
): Promise<MobileWorktreeForkBase | null> {
  return new Promise((resolve) => {
    Alert.alert(
      translate('chat.fork.worktree.title', 'Fork into a new worktree'),
      translate(
        'chat.fork.worktree.message',
        'The new worktree opens a copy of this chat. Start its branch from:'
      ),
      [
        {
          text: translate('chat.fork.worktree.baseMain', 'Main branch'),
          style: 'default',
          isPreferred: true,
          onPress: () => resolve('main')
        },
        ...(branch
          ? [
              {
                text: translate('chat.fork.worktree.baseCurrent', 'This branch ({{branch}})', {
                  branch
                }),
                onPress: () => resolve('current' as const)
              }
            ]
          : []),
        {
          text: translate('chat.fork.worktree.cancel', 'Cancel'),
          style: 'cancel',
          onPress: () => resolve(null)
        }
      ],
      { cancelable: true, onDismiss: () => resolve(null) }
    )
  })
}

/** Creates a sibling worktree, opens the copied chat there and goes to it; the source is untouched. */
export async function forkMobileStructuredChatIntoWorktree(input: {
  client: RpcClient | null
  sourceWorktreeId: string
  agent: TuiAgent
  forkFrom: StructuredAgentSessionForkSource
  mode?: MobileWorktreeForkMode
  /** The chat a subagent reports back to, by name. */
  sourceLabel?: string
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  showToast: (message: string, durationMs?: number) => void
  openWorktree: (worktreeId: string, name: string, warning?: string) => void
}): Promise<void> {
  const agentName = TUI_AGENT_DISPLAY_NAMES[input.agent]
  const report = (message: string): void => {
    triggerError()
    input.showToast(message, 3000)
  }
  const { client } = input
  if (!client) {
    report(mobileWorktreeForkCopy.offline())
    return
  }
  // Only names and the branch come from it; an unread record leaves the main-branch fork.
  const source = await sessionWorktreeRecordRead
    .request(client, { worktree: `id:${input.sourceWorktreeId}` })
    .then((response) => {
      const record = sessionWorktreeRecordRead.interpret(response)
      return record.accepted ? record.value : undefined
    })
    .catch(() => undefined)
  const branch = source?.branch?.trim() || null
  const base = await askMobileWorktreeForkBase(branch)
  if (!base) {
    return
  }
  const subagent = input.mode === 'subagent'
  const task = subagent ? await askMobileSubagentTask() : null
  if (subagent && !task) {
    return
  }
  const sourceName = source?.displayName?.trim() || branch || 'chat'
  const baseName = slugifyForWorkspaceName(`${sourceName}-fork`) || 'session-fork'
  const repoId = source?.repoId ?? getRepoIdFromWorktreeId(input.sourceWorktreeId)
  const created = await createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: input.worktreeCreateIdempotency,
    // A taken name retries as name-2, name-3…; the title says the same number.
    buildParams: (name, attempt) => ({
      repo: `id:${repoId}`,
      setupDecision: 'inherit',
      name,
      displayName: attempt === 0 ? `Fork of ${sourceName}` : `Fork ${attempt + 1} of ${sourceName}`,
      displayNameKind: 'user' as const,
      createdWithAgent: input.agent,
      ...(base === 'current' && branch ? { baseBranch: branch } : {})
    }),
    // Nested under its source, so the sidebar shows forks as a tree.
    parent: { parentWorkspace: input.sourceWorktreeId, parentWorkspaceOrigin: 'manual' }
  }).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : mobileWorktreeForkCopy.createFailed()
  }))
  if ('error' in created) {
    report(created.error)
    return
  }
  const result = await createMobileStructuredAgentSession(
    client,
    created.worktreeId,
    input.agent,
    input.forkFrom,
    undefined,
    task
      ? subagentFirstMessage(task, input.forkFrom.sessionId, input.sourceLabel ?? input.agent)
      : undefined
  ).catch(() => ({ kind: 'unknown' as const }))
  // A subagent works in the background; you stay in this chat.
  if (task) {
    if (result.kind === 'created') {
      input.showToast(
        translate('chat.fork.subagent.started', 'Subagent started in {{name}}', {
          name: created.name
        }),
        3000
      )
    }
  } else {
    input.openWorktree(created.worktreeId, created.name, created.warning)
  }
  if (result.kind === 'unknown') {
    report(mobileWorktreeForkCopy.unconfirmed(agentName))
  } else if (result.kind !== 'created') {
    report(
      mobileWorktreeForkCopy.failed(
        agentName,
        result.kind === 'failed' ? result.message : mobileWorktreeForkCopy.unsupported()
      )
    )
  }
}

const mobileWorktreeForkCopy = {
  offline: () =>
    translate('chat.fork.worktree.offline', 'Connect to the host, then fork the chat again.'),
  createFailed: () => translate('chat.fork.worktree.createFailed', 'Couldn’t create the worktree.'),
  unconfirmed: (agent: string) =>
    translate(
      'chat.fork.unconfirmed',
      "{{agent}} couldn't confirm the fork. It may have opened anyway; check Session History before forking again.",
      { agent }
    ),
  failed: (agent: string, detail: string) =>
    translate('chat.fork.failed', "{{agent}} couldn't fork this chat. {{detail}}", {
      agent,
      detail
    }),
  unsupported: () =>
    translate(
      'chat.fork.unsupported',
      'This host runs an older Orca. Update Orca on the host, then try again.'
    )
}
