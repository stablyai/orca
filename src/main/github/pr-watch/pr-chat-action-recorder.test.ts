import { describe, expect, it } from 'vitest'
import type { JournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import { finishedShellCalls, pushUpdatesByCall } from './pr-chat-action-recorder'

function toolCallRow(body: Record<string, unknown>): JournalRow {
  const head = typeof body.output === 'string' ? body.output : ''
  return {
    kind: 'item',
    itemId: 'claude:session:toolu_01',
    revision: 2,
    body: {
      kind: 'tool-call',
      state: 'completed',
      ...body,
      output: { head, byteLength: head.length, digest: 'd', truncated: false }
    }
  } as unknown as JournalRow
}

function pushedBranches(row: JournalRow): unknown[] {
  return finishedShellCalls('chat-1', [row]).flatMap(pushUpdatesByCall)
}

describe('push updates from recorded tool calls', () => {
  it("reads Claude's Bash push and Codex's shell push", () => {
    // Claude's Bash tool: git writes its update lines to stderr, which the tool merges.
    const claude = toolCallRow({
      name: 'Bash',
      input: { command: 'git push -u origin HEAD', description: 'Push the branch' },
      output:
        "To github.com:stablyai/orca.git\n   8d5f74b..c512e75  HEAD -> brennanb2025/ci-lines\nbranch 'brennanb2025/ci-lines' set up to track 'origin/brennanb2025/ci-lines'."
    })
    // Codex app-server: one string through a login shell, with its cwd and exit code.
    const codex = toolCallRow({
      name: 'shell',
      input: {
        command: "/bin/zsh -lc 'git add -A && git commit -m wip && git push --force-with-lease'",
        cwd: '/Users/me/orca/workspaces/orca/ci-lines'
      },
      exitCode: 0,
      output:
        '[ci-lines 5d6e7f8] wip\n 1 file changed, 2 insertions(+)\nTo github.com:stablyai/orca.git\n + 1a2b3c4...5d6e7f8 ci-lines -> ci-lines (forced update)\n'
    })
    expect(pushedBranches(claude)).toEqual([{ branch: 'brennanb2025/ci-lines', newSha: 'c512e75' }])
    expect(pushedBranches(codex)).toEqual([{ branch: 'ci-lines', newSha: '5d6e7f8' }])
    expect(finishedShellCalls('chat-1', [codex])[0]?.cwd).toBe(
      '/Users/me/orca/workspaces/orca/ci-lines'
    )
  })

  it('takes new branches and porcelain lines, and nothing from pushes that updated nothing', () => {
    const push = (command: string, output: string) =>
      pushedBranches(toolCallRow({ name: 'Bash', input: { command }, output }))
    expect(
      push(
        'git push -u origin feature',
        "remote: Create a pull request for 'feature' on GitHub by visiting:\nTo github.com:acme/repo.git\n * [new branch]      feature -> feature\n"
      )
    ).toEqual([{ branch: 'feature', newSha: null }])
    expect(
      push(
        'git push --porcelain',
        'To github.com:acme/repo.git\n \trefs/heads/feature:refs/heads/feature\t8d5f74b..c512e75\nDone\n'
      )
    ).toEqual([{ branch: 'feature', newSha: 'c512e75' }])
    expect(
      push(
        'git push',
        'To github.com:acme/repo.git\n ! [rejected]        feature -> feature (fetch first)\n'
      )
    ).toEqual([])
    expect(push('git push', 'Everything up-to-date\n')).toEqual([])
    expect(push('git push -q', '')).toEqual([])
    expect(
      push(
        'git push --dry-run',
        'To github.com:acme/repo.git\n   8d5f74b..c512e75  feature -> feature\n'
      )
    ).toEqual([])
    expect(
      push(
        'echo "git push"',
        'To github.com:acme/repo.git\n   8d5f74b..c512e75  feature -> feature\n'
      )
    ).toEqual([])
  })
})
