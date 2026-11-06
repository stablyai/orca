import { describe, expect, it } from 'vitest'
import type { JournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import {
  finishedShellCall,
  pushedPullRequestHead,
  pushUpdatesByCall
} from './pr-chat-action-recorder'

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
  const call = row.kind === 'item' ? finishedShellCall('chat-1', row, 0) : null
  return (call ? pushUpdatesByCall(call) : []).map(({ branch, newSha }) => ({ branch, newSha }))
}

const TO_ORIGIN = 'To github.com:acme/repo.git\n'

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
    // Dry runs print real-looking updates however the option is written.
    for (const command of ["git push origin feature '--dry-run'", 'git push -nv origin feature']) {
      expect(push(command, `${TO_ORIGIN}   8d5f74b..c512e75  feature -> feature\n`)).toEqual([])
    }
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

describe('pushedPullRequestHead', () => {
  const updateOf = (output: string) =>
    pushUpdatesByCall({
      chatId: 'chat-1',
      anchor: { itemId: 'item', revision: 1 },
      script: 'git push',
      output,
      finishedAt: 0
    })[0]!
  // The remote as resolved through the checkout's config; here, what the `To` line parsed to.
  const match = (output: string, pr: PRInfo) => {
    const update = updateOf(output)
    return pushedPullRequestHead(update, update.remote, pr)
  }
  const pr = (fields: Partial<PRInfo>): PRInfo =>
    ({
      number: 20,
      headRefName: 'review',
      headSha: '89abcde0123',
      headRepo: { owner: 'acme', repo: 'repo' },
      ...fields
    }) as PRInfo

  it('binds a push to the branch, repository and forge host its own update line names', () => {
    // `git push origin work:review` updated review, not the checked-out branch.
    const workToReview = `${TO_ORIGIN}   1234567..89abcde  work -> review\n`
    expect(match(workToReview, pr({}))).toEqual({ headSha: '89abcde0123', superseded: false })
    // A new branch in another repository is not this fork PR's head.
    expect(
      match('To github.com:parent/repo.git\n * [new branch]      HEAD -> review\n', pr({}))
    ).toBeNull()
    // The same commit pushed to the same owner/repo on another forge host is another repository.
    expect(
      match(
        'To https://github.enterprise.example/acme/repo.git\n   1234567..89abcde  work -> review\n',
        pr({})
      )
    ).toBeNull()
    // Another push moved the PR on before the read: the proven head is kept, marked superseded.
    expect(match(workToReview, pr({ headSha: 'ffff0000aaaa' }))).toEqual({
      headSha: '89abcde',
      superseded: true
    })
  })
})
