// `worktree compare` starts one agent that reads several attempts at a task and recommends one.

import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  parseCliAgent,
  readCliAgentLaunch
} from '../agents/agent-launch-request'
import {
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  getRequiredWorktreeSelector,
  normalizeWorktreeSelectorForCaller,
  resolveCurrentWorktreeSelector
} from '../workspace-selection/workspace-selector'

const MAX_CANDIDATES = 8

type CompareCandidate = { path: string; branch: string; baseRef?: string }

export function buildWorktreeComparePrompt(
  candidates: readonly CompareCandidate[],
  task?: string
): string {
  const lines = candidates.map(({ path, branch, baseRef }, index) => {
    const base = baseRef ? `, base ${baseRef}` : ''
    return `${index + 1}. ${path} (branch ${branch.replace(/^refs\/heads\//, '') || 'detached'}${base})`
  })
  return [
    `Compare these ${candidates.length} attempts at the same task and recommend one. Only read: do not edit, stage, commit, push or delete anything in any checkout.`,
    ...(task ? ['', `Task: ${task}`] : []),
    '',
    'Candidates:',
    ...lines,
    '',
    'For each candidate, read its whole change against its base: commits since the merge base, uncommitted edits and untracked files (for example `git -C <path> diff --merge-base <base>` and `git -C <path> status --short`). If a base is not listed, use the repository default branch.',
    'Judge correctness, completeness, code quality and risk. Run checks only if they do not modify the checkouts.',
    'Reply with the candidates ranked best to worst, each with a 0-10 score and a one-line reason, then the recommended winner by number and path, and anything worth porting from the others.'
  ].join('\n')
}

async function showCandidate(
  client: Parameters<CommandHandler>[0]['client'],
  selector: string
): Promise<RuntimeWorktreeRecord> {
  return (
    await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', { worktree: selector })
  ).result.worktree
}

export const WORKTREE_COMPARE_HANDLERS: Record<string, CommandHandler> = {
  'worktree compare': async ({ flags, client, cwd, json, rawArgs }) => {
    const selectors = getRepeatedStringFlag(flags, 'worktree')
    if (selectors.length < 2 || selectors.length > MAX_CANDIDATES) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Pass 2 to ${MAX_CANDIDATES} worktrees to compare, repeating --worktree once per candidate.`
      )
    }
    const agent = parseCliAgent(getRequiredStringFlag(flags, 'agent'))
    const launch = readCliAgentLaunch(flags, agent, { createsWorktree: false })
    if (client.isRemote && !flags.has('judge-worktree')) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Remote compare requires --judge-worktree because the client cwd cannot identify a server worktree.'
      )
    }
    const judgeSelector = flags.has('judge-worktree')
      ? await getRequiredWorktreeSelector(flags, 'judge-worktree', cwd, client)
      : await resolveCurrentWorktreeSelector(cwd, client, { agent })
    const candidates: RuntimeWorktreeRecord[] = []
    for (const selector of selectors) {
      const candidate = await showCandidate(
        client,
        await normalizeWorktreeSelectorForCaller(selector, cwd, client)
      )
      if (candidates.some((existing) => existing.id === candidate.id)) {
        throw new RuntimeClientError('invalid_argument', `${selector} is listed more than once.`)
      }
      candidates.push(candidate)
    }
    const judge = (
      await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
        worktree: judgeSelector,
        matchFolderWorkspaces: true
      })
    ).result.worktree
    const elsewhere = candidates.find(
      (candidate) => candidate.hostId && judge.hostId && candidate.hostId !== judge.hostId
    )
    if (elsewhere) {
      // The judge reads candidates by path, so they must be on its host.
      throw new RuntimeClientError(
        'invalid_argument',
        `${elsewhere.git.path} is on ${elsewhere.hostId}, but the judge would run on ${judge.hostId}. Pass --judge-worktree on the candidates' host.`
      )
    }
    const capabilities = await getAgentLaunchCapabilities(client)
    if (!capabilities) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot start agents from the CLI. Update Orca on the execution host.'
      )
    }
    const prompt = buildWorktreeComparePrompt(
      candidates.map(({ git, baseRef }) => ({ path: git.path, branch: git.branch, baseRef })),
      getOptionalStringFlag(flags, 'task')
    )
    const result = await callAgentLaunch(
      client,
      { ...launch, prompt: { text: prompt, delivery: 'submit' } },
      {
        target: { kind: 'existing', worktree: judgeSelector },
        presentation: flags.get('focus') === true ? 'focused' : 'background'
      },
      capabilities,
      rawArgs
    )
    printResult(result, json, formatAgentLaunch)
  }
}
