import { describe, expect, it } from 'vitest'
import { botWorkHasPrBranch, type BotBranchWorkspace, type BotWorkRows } from './bot-work-pr-branch'
import type { BotWorkRow } from './bot-work-store'

const REPO = { repoId: 101, repoFullName: 'org/repo' }
const opened = (headRef: string, number = 7) => ({ ...REPO, number, head: REPO, headRef })

const row = (overrides: Partial<BotWorkRow> = {}): BotWorkRow => ({
  rowId: 'row-1',
  generation: 1,
  botId: 'bot-1',
  address: { source: 'slack', externalId: 'T1:C1:1.0' },
  taskId: 'task',
  dispatchId: 'd1',
  host: 'local',
  current: true,
  askedInApp: false,
  createdAt: 0,
  closedAt: null,
  closeReason: null,
  ...overrides
})

const workspace = (
  branch: string,
  repo: { id: number | null; fullName: string } | null = { id: REPO.repoId, fullName: 'Org/Repo' }
): BotBranchWorkspace => ({
  branch: `refs/heads/${branch}`,
  githubRepo: async () => repo
})

function work(rows: BotWorkRow[], workspaces: (BotBranchWorkspace | null)[]): BotWorkRows {
  return {
    rows: () => rows,
    workspace: async (checked) => workspaces[rows.indexOf(checked)] ?? null
  }
}

describe('botWorkHasPrBranch', () => {
  it("knows a bot worker's pull request by its workspace's branch, in the head's repository", async () => {
    const fixing = work([row()], [workspace('fix-login')])
    expect(await botWorkHasPrBranch(fixing, opened('fix-login'))).toBe(true)
    // The owner's own branch is not the bot's work.
    expect(await botWorkHasPrBranch(fixing, opened('carol/by-hand', 9))).toBe(false)
    // Nor is the same branch name in another repository, such as a fork.
    const fork = { ...opened('fix-login'), head: { repoId: 999, repoFullName: '' } }
    expect(await botWorkHasPrBranch(fixing, fork)).toBe(false)
  })

  it('matches a workspace whose repository is known by name only, by that name', async () => {
    const byName = (fullName: string) =>
      work([row()], [workspace('fix-login', { id: null, fullName })])
    expect(await botWorkHasPrBranch(byName('Org/Repo'), opened('fix-login'))).toBe(true)
    expect(await botWorkHasPrBranch(byName('org/other'), opened('fix-login'))).toBe(false)
  })

  it("doesn't take an unreadable workspace, or no work at all, as the bot's", async () => {
    expect(await botWorkHasPrBranch(work([row()], [null]), opened('fix-login'))).toBe(false)
    expect(await botWorkHasPrBranch(work([], []), opened('fix-login'))).toBe(false)
  })

  it("takes a workspace on the branch whose repository can't be told as the bot's", async () => {
    const unknownRepo = work([row()], [workspace('fix-login', null)])
    expect(await botWorkHasPrBranch(unknownRepo, opened('fix-login'))).toBe(true)
    // Known by name only, against a fork the pull request names by id alone.
    const byName = work([row()], [workspace('fix-login', { id: null, fullName: 'owner/fork' })])
    const fork = { ...opened('fix-login'), head: { repoId: 999, repoFullName: '' } }
    expect(await botWorkHasPrBranch(byName, fork)).toBe(true)
    // Another branch is never the bot's, whatever its repository.
    expect(await botWorkHasPrBranch(unknownRepo, opened('carol/by-hand'))).toBe(false)
  })
})
