import { Alert } from 'react-native'
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
  const sourceName = source?.displayName?.trim() || branch || 'chat'
  const baseName = slugifyForWorkspaceName(`${sourceName}-fork`) || 'session-fork'
  const repoId = source?.repoId ?? getRepoIdFromWorktreeId(input.sourceWorktreeId)
  const created = await createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: input.worktreeCreateIdempotency,
    buildParams: (name) => ({
      repo: `id:${repoId}`,
      setupDecision: 'inherit',
      name,
      displayName: `Fork of ${sourceName}`,
      displayNameKind: 'user' as const,
      createdWithAgent: input.agent,
      ...(base === 'current' && branch ? { baseBranch: branch } : {})
    })
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
    input.forkFrom
  ).catch(() => ({ kind: 'unknown' as const }))
  input.openWorktree(created.worktreeId, created.name, created.warning)
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
