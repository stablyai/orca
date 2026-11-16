import type { PersistedTrustedOrcaHooks } from '../../../../src/shared/workspace-setup/orca-yaml-hook-types'
import {
  PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY,
  WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY
} from '../../../../src/shared/remote-runtime/protocol/worktree-runtime-capabilities'
import type { SetupTrustMismatch } from '../../../../src/shared/worktree/create-types'
import type { OrcaHookTrustPrompt } from '../../components/hook-trust/OrcaHookTrustDrawer'
import { translate } from '../../i18n/mobile-i18n'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import {
  worktreeCreateCapabilityRead,
  worktreeRunApprovedSetupRun
} from './mobile-workspace-create-operations'
import { usesVersionedOrcaHookTrust, wasOrcaHookPreviouslyApproved } from './setup-hook-trust'

/** The create's reply when the host skipped setup because the created branch's differs from the approved one. */
export function readSetupTrustMismatch(result: unknown): SetupTrustMismatch | undefined {
  const mismatch =
    result && typeof result === 'object' && 'setupTrustMismatch' in result
      ? result.setupTrustMismatch
      : undefined
  if (
    !mismatch ||
    typeof mismatch !== 'object' ||
    !('contentHash' in mismatch) ||
    !('scriptContent' in mismatch) ||
    typeof mismatch.contentHash !== 'string' ||
    typeof mismatch.scriptContent !== 'string' ||
    !mismatch.contentHash
  ) {
    return undefined
  }
  return { contentHash: mismatch.contentHash, scriptContent: mismatch.scriptContent }
}

export function createdSetupReviewPrompt(args: {
  repo: { id: string; displayName: string }
  repos: readonly { id: string }[]
  trust: PersistedTrustedOrcaHooks
  mismatch: SetupTrustMismatch
}): OrcaHookTrustPrompt {
  return {
    kind: 'setup',
    review: 'created-branch',
    repoId: args.repo.id,
    repoName: args.repo.displayName,
    scriptContent: args.mismatch.scriptContent,
    contentHash: args.mismatch.contentHash,
    previouslyApproved: wasOrcaHookPreviouslyApproved(args.trust, args.repo.id, 'setup'),
    versionOnly: usesVersionedOrcaHookTrust(args.repos, args.repo.id)
  }
}

/** Runs the reviewed setup in the created workspace; returns a notice when it didn't start. */
export async function runReviewedCreatedSetup(
  client: RpcClient,
  worktreeId: string,
  approvedSetupHash: string
): Promise<string | undefined> {
  const unsupported = translate(
    'newWorkspace.createdSetupReview.hostUnsupported',
    'Approved. Update Orca on the workspace host to run setup for an existing workspace.'
  )
  try {
    const status = worktreeCreateCapabilityRead.interpret(
      await worktreeCreateCapabilityRead.request(client)
    )
    const capability = worktreeId.startsWith('folder:')
      ? PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY
      : WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY
    if (!status.accepted || !status.value.capabilities?.includes(capability)) {
      return unsupported
    }
    const reply = await worktreeRunApprovedSetupRun.request(client, {
      worktree: `id:${worktreeId}`,
      approvedSetupHash
    })
    // Hosts that predate this phone method refuse it at the mobile allowlist.
    if (!reply.ok && isMobileMethodUnavailableError(reply.error.code, reply.error.message)) {
      return unsupported
    }
    return worktreeRunApprovedSetupRun.interpret(reply).status === 'mismatch'
      ? translate(
          'newWorkspace.createdSetupReview.changedAgain',
          "Setup didn't run: this workspace's orca.yaml changed again since you reviewed it."
        )
      : undefined
  } catch {
    return createdSetupRunFailed()
  }
}

export function createdSetupRunFailed(): string {
  return translate('newWorkspace.createdSetupReview.runFailed', 'Could not start setup.')
}
