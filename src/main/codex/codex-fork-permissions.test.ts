import { CODEX_RESTORE_MAX_BYTES } from './codex-structured-journal-translation-restore'
import { codexForkSandboxFromProfile } from './codex-fork-permission-profile'
import { mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexForkPermissions } from './codex-fork-permissions'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function transcript(policy: unknown) {
  const accountHome = await mkdtemp(join(tmpdir(), 'codex-fork-permissions-'))
  roots.push(accountHome)
  const path = join(accountHome, 'rollout.jsonl')
  await writeFile(
    path,
    `${[
      { type: 'session_meta', payload: { id: 'parent' } },
      {
        type: 'turn_context',
        payload: {
          approval_policy: 'on-request',
          approvals_reviewer: 'user',
          sandbox_policy: { type: 'danger-full-access' }
        }
      },
      {
        type: 'turn_context',
        payload: { approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: policy }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
  )
  return { accountHome, path, threadId: 'parent' }
}

describe('inherited Codex own permissions', () => {
  it('preserves the latest native read-only / never policy instead of current global defaults', async () => {
    expect(await readCodexForkPermissions(await transcript({ type: 'read-only' }))).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only'
    })
  })

  it('reads a fresh fork policy before any first user turn exists', async () => {
    const input = await transcript({ type: 'read-only' })
    await writeFile(
      input.path,
      `${[
        { type: 'session_meta', payload: { id: 'parent' } },
        {
          type: 'event_msg',
          payload: {
            type: 'thread_settings_applied',
            thread_id: 'parent',
            thread_settings: {
              approval_policy: 'never',
              approvals_reviewer: 'user',
              permission_profile: { type: 'disabled' }
            }
          }
        }
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`
    )
    expect(await readCodexForkPermissions(input)).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access'
    })
  })

  it('preserves all workspace sandbox settings without inventing roots or networking', async () => {
    expect(
      await readCodexForkPermissions(
        await transcript({
          type: 'workspace-write',
          writable_roots: ['/allowed'],
          network_access: true,
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true
        })
      )
    ).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: {
        'sandbox_workspace_write.writable_roots': ['/allowed'],
        'sandbox_workspace_write.network_access': true,
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'sandbox_workspace_write.exclude_slash_tmp': true
      }
    })
  })

  it('refuses unsupported custom policy fields and incomplete history', async () => {
    const input = await transcript({ type: 'read-only', unknown_future_grant: true })
    await expect(readCodexForkPermissions(input)).rejects.toThrow('cannot be safely inherited')
    await writeFile(
      input.path,
      '{"type":"session_meta","payload":{"id":"parent"}}\n{"type":"turn_context"'
    )
    await expect(readCodexForkPermissions(input)).rejects.toThrow('cannot be safely inherited')
  })

  it('bounds the whole file even when the shared reader would skip oversized records', async () => {
    const input = await transcript({ type: 'read-only' })
    await truncate(input.path, CODEX_RESTORE_MAX_BYTES + 1)
    await expect(readCodexForkPermissions(input)).rejects.toThrow('too large')
  })

  it('recognizes a canonical workspace profile on a fresh fork without accepting extra grants', async () => {
    const input = await transcript({ type: 'read-only' })
    const cwd = await realpath(input.accountHome)
    const extra = join(cwd, 'allowed')
    const roots = [cwd, extra]
    const entries = [
      { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
      ...[...roots, extra].map((path) => ({ path: { type: 'path', path }, access: 'write' })),
      { path: { type: 'special', value: { kind: 'tmpdir' } }, access: 'write' },
      ...roots.flatMap((root) =>
        ['.git', '.agents', '.codex', '.aws'].map((name) => ({
          path: { type: 'path', path: join(root, name) },
          access: 'read',
          missing_path_behavior: 'skip'
        }))
      )
    ]
    const profile = {
      type: 'managed',
      file_system: { type: 'restricted', entries },
      network: 'enabled'
    }
    expect(await codexForkSandboxFromProfile(profile, cwd)).toEqual({
      type: 'workspace-write',
      writable_roots: [extra],
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: true
    })
    const custom = {
      ...profile,
      file_system: {
        ...profile.file_system,
        entries: [
          ...entries,
          {
            path: { type: 'path', path: join(extra, 'private') },
            access: 'read',
            missing_path_behavior: 'skip'
          }
        ]
      }
    }
    expect(await codexForkSandboxFromProfile(custom, cwd)).toBeUndefined()
  })

  it('checks account containment and rollout identity before reading permissions', async () => {
    const input = await transcript({ type: 'danger-full-access' })
    await expect(
      readCodexForkPermissions({ ...input, accountHome: join(input.accountHome, 'other-account') })
    ).rejects.toThrow('could not be verified')
    await expect(readCodexForkPermissions({ ...input, threadId: 'foreign' })).rejects.toThrow(
      'could not be verified'
    )
  })
})
