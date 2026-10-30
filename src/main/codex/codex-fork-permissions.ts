import { stat } from 'node:fs/promises'
import { codexForkSandboxFromProfile } from './codex-fork-permission-profile'
import { z } from 'zod'
import { admitTranscriptPath } from '../native-chat/transcript-path-admission'
import { consumeCompleteJsonlLines } from '../ai-vault/session-scanner-jsonl-reader'
import { readCodexRolloutSessionMetaId } from './codex-rollout-session-meta'
import { CODEX_RESTORE_MAX_BYTES } from './codex-structured-journal-translation-restore'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'

const sandbox = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('read-only') }),
  z.strictObject({ type: z.literal('danger-full-access') }),
  z.strictObject({
    type: z.literal('workspace-write'),
    writable_roots: z.array(z.string()).default([]),
    network_access: z.boolean().default(false),
    exclude_tmpdir_env_var: z.boolean().default(false),
    exclude_slash_tmp: z.boolean().default(false)
  })
])
const permissions = z.object({
  approval_policy: z.enum(['never', 'on-request', 'untrusted']),
  approvals_reviewer: z.enum(['user', 'auto_review', 'guardian_subagent']),
  sandbox_policy: sandbox
})

/** Own mode must inherit provider evidence; native fork otherwise reads the latest global sandbox. */
export async function readCodexForkPermissions(input: {
  accountHome: string
  threadId: string
  path: unknown
  signal?: AbortSignal
}) {
  const admitted =
    typeof input.path === 'string' ? await admitTranscriptPath(input.accountHome, input.path) : null
  if (
    !admitted ||
    (await readCodexRolloutSessionMetaId(admitted.path, input.signal)) !== input.threadId
  ) {
    throw new Error('The parent Codex permission policy could not be verified in its account.')
  }
  if ((await stat(admitted.path)).size > CODEX_RESTORE_MAX_BYTES) {
    throw new Error('Codex permission history is too large to import.')
  }
  let latest: unknown
  let bytes = 0
  const read = await consumeCompleteJsonlLines({
    path: admitted.path,
    start: 0,
    signal: input.signal,
    onLine: (line) => {
      bytes += Buffer.byteLength(line, 'utf8') + 1
      if (bytes > CODEX_RESTORE_MAX_BYTES) {
        throw new Error('Codex permission history is too large to import.')
      }
      let record: Record<string, unknown>
      try {
        record = readCodexJournalRecord(JSON.parse(line))
      } catch {
        throw new Error('The parent Codex permission history is unreadable.')
      }
      if (record.type === 'turn_context') {
        latest = record.payload
      } else if (record.type === 'event_msg') {
        const payload = readCodexJournalRecord(record.payload)
        if (payload.type === 'thread_settings_applied' && payload.thread_id === input.threadId) {
          latest = payload.thread_settings
        }
      }
    }
  })
  const settings = readCodexJournalRecord(latest)
  const parsed = permissions.safeParse(
    'permission_profile' in settings
      ? {
          ...settings,
          sandbox_policy: await codexForkSandboxFromProfile(
            settings.permission_profile,
            settings.cwd
          )
        }
      : settings
  )
  if (!parsed.success || read.skippedRecords.length || read.trailingPartialLine) {
    throw new Error(
      'The parent Codex custom permission policy cannot be safely inherited. Choose an explicit permission mode before branching.'
    )
  }
  const policy = parsed.data.sandbox_policy
  return {
    approvalPolicy: parsed.data.approval_policy,
    approvalsReviewer: parsed.data.approvals_reviewer,
    sandbox: policy.type,
    ...(policy.type === 'workspace-write'
      ? {
          config: {
            'sandbox_workspace_write.writable_roots': policy.writable_roots,
            'sandbox_workspace_write.network_access': policy.network_access,
            'sandbox_workspace_write.exclude_tmpdir_env_var': policy.exclude_tmpdir_env_var,
            'sandbox_workspace_write.exclude_slash_tmp': policy.exclude_slash_tmp
          }
        }
      : {})
  }
}
