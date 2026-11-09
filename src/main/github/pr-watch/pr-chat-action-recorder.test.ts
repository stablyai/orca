import { describe, expect, it } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import {
  finishedShellCall,
  pushedPullRequestHead,
  pushUpdatesByCall
} from './pr-chat-action-recorder'
import { prInfoFixture } from './pr-watch-test-fixtures'

type ToolCallRow = { itemId: string; revision: number; body: AgentJournalToolCallItem }

function toolCallRow(
  call: Omit<AgentJournalToolCallItem, 'kind' | 'state' | 'output'> & { output: string }
): ToolCallRow {
  const head = call.output
  return {
    itemId: 'claude:session:toolu_01',
    revision: 2,
    body: {
      ...call,
      kind: 'tool-call',
      state: 'completed',
      output: { head, byteLength: head.length, digest: 'd', truncated: false }
    }
  }
}

function pushedBranches(row: ToolCallRow): unknown[] {
  const call = finishedShellCall('chat-1', row, 0)
  return (call ? pushUpdatesByCall(call) : []).map(({ branch, newSha }) => ({ branch, newSha }))
}

const TO_ORIGIN = 'To github.com:acme/repo.git\n'
const REVIEW_PUSHED =
  "To github.com:acme/repo.git\n   8d5f74b..c512e75  HEAD -> review\nbranch 'review' set up to track 'origin/review'.\n"
const REVIEW_UPDATE = { branch: 'review', newSha: 'c512e75' }

function pushBy(command: string, output: string): unknown[] {
  return pushedBranches(toolCallRow({ name: 'Bash', input: { command }, output }))
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
  })

  it("reads a push after a heredoc's declaration, past `;`", () => {
    const command = "cat <<'EOF' > notes.md; git push -u origin HEAD 2>&1\nnotes\nEOF"
    expect(pushBy(command, REVIEW_PUSHED)).toEqual([REVIEW_UPDATE])
  })

  it('takes nothing from a heredoc that prints a push and its update lines', () => {
    const printed =
      'git push -u origin HEAD 2>&1\nTo github.com:acme/repo.git\n   1234567..89abcde  HEAD -> review\n'
    for (const opener of ["<<'EOF'", '<<EOF', '<<"EOF"']) {
      expect(pushBy(`cat ${opener}\n${printed}EOF`, printed)).toEqual([])
    }
    const indented = printed.replace(/^/gmu, '\t').replace(/\t$/u, '')
    expect(pushBy(`cat <<-EOF\n${indented}\tEOF`, printed)).toEqual([])
  })

  it("doesn't let an escaped `>` before a real pipe hide the push after it", () => {
    expect(pushBy('printf x \\>|git push origin HEAD', REVIEW_PUSHED)).toEqual([REVIEW_UPDATE])
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
    prInfoFixture({
      number: 20,
      headRefName: 'review',
      headSha: '89abcde0123',
      headRepo: { owner: 'acme', repo: 'repo' },
      ...fields
    })

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
