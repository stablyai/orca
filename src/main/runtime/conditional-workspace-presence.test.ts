import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createConditionalWorkspaceMatcher } from './conditional-workspace-presence'
import { agentSessionWorkspacePresence } from './agent-session-workspace-presence'
import {
  conditionalSessionWorkspacePresence,
  conditionalSnapshotWorkspacePresence
} from './conditional-workspace-session-presence'

let root: string
let workspace: string
let alias: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-presence-alias-')))
  const checkout = join(root, 'checkout')
  const link = join(root, 'alias')
  await mkdir(checkout)
  await symlink(checkout, link, 'junction')
  workspace = `repo::${checkout}`
  alias = `repo::${link}`
})
afterEach(() => rm(root, { recursive: true, force: true }))

it.each(['exact', 'alias', 'missing', 'foreign'] as const)(
  'checks %s saved records, snapshots and session maps without changing their identity',
  (kind) => {
    const candidate =
      kind === 'exact' || kind === 'foreign'
        ? workspace
        : kind === 'alias'
          ? alias
          : `repo::${join(root, 'missing')}`
    const host = kind === 'foreign' ? 'ssh:other' : 'local'
    const match = createConditionalWorkspaceMatcher(workspace, 'local')
    const expected = kind === 'foreign' ? 'idle' : kind === 'missing' ? 'unknown' : 'live'
    const record = { location: { workspaceId: candidate, executionHostId: host } }
    const records = new Map([['session', record]])
    expect(
      agentSessionWorkspacePresence({ records, unreadableRecords: { size: 0 } }, false, workspace)
    ).toBe(expected === 'live' ? 'present' : expected === 'idle' ? 'absent' : 'unknown')
    expect(
      conditionalSessionWorkspacePresence(
        {
          openFilesByWorktree: {
            [candidate]: [
              {
                filePath: 'note.md',
                relativePath: 'note.md',
                worktreeId: candidate,
                language: 'markdown'
              }
            ]
          }
        },
        host,
        match
      )
    ).toBe(expected)
    expect(
      conditionalSnapshotWorkspacePresence(
        [
          {
            worktree: candidate,
            tabs: [],
            initialSurfaceLaunch: { launchId: 'launch', agent: 'codex' }
          }
        ],
        match,
        () => host
      )
    ).toBe(expected)
    expect(record.location.workspaceId).toBe(candidate)
  }
)

it('keeps snapshots with unprovable hosts and saved unreadable identities', () => {
  const match = createConditionalWorkspaceMatcher(workspace, 'local')
  expect(
    conditionalSnapshotWorkspacePresence(
      [
        {
          worktree: alias,
          tabs: [],
          initialSurfaceLaunch: { launchId: 'launch', agent: 'codex' }
        }
      ],
      match,
      () => undefined
    )
  ).toBe('unknown')
  expect(conditionalSessionWorkspacePresence({ activeWorktreeId: 'legacy' }, 'local', match)).toBe(
    'unknown'
  )
  expect(
    conditionalSessionWorkspacePresence(
      {
        activeWorkspaceKey: `worktree:${alias}`,
        activeWorkspaceExecutionHostId: 'local'
      },
      'local',
      match
    )
  ).toBe('live')
})

it('does not confuse an existing different directory with the checkout', async () => {
  const other = join(root, 'other')
  await mkdir(other)
  expect(createConditionalWorkspaceMatcher(workspace, 'local')(`repo::${other}`, 'local')).toBe(
    'different'
  )
})
