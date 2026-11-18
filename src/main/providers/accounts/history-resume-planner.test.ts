import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryResumePlanner } from './history-resume-planner'
import { HistoryContinuationLedger } from './history-continuation-ledger'
import type { AiVaultPrepareSessionResumeArgs } from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'

const sessionId = '00000000-0000-4000-8000-000000000010'
let root: string
let ledger: HistoryContinuationLedger
let planner: HistoryResumePlanner
let args: AiVaultPrepareSessionResumeArgs
let workspaceAccountId: string | undefined
let workAvailable = true
let original: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-resume-plan-'))
  const home = join(root, 'system')
  const target = join(root, 'work')
  const workspace = join(root, 'workspace')
  const directory = join(home, 'sessions', '2026', '11', '17')
  await Promise.all([directory, target, workspace].map((path) => mkdir(path, { recursive: true })))
  original = `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspace } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep my original conversation' }] } })}\n`
  const filePath = join(directory, `rollout-2026-11-17T10-00-00-${sessionId}.jsonl`)
  await writeFile(filePath, original)
  await writeFile(join(target, 'auth.json'), 'work-login')
  ledger = new HistoryContinuationLedger(join(root, 'ledger.json'))
  workspaceAccountId = undefined
  workAvailable = true
  planner = new HistoryResumePlanner({
    ledger,
    roots: async () => [join(home, 'sessions'), join(target, 'sessions')],
    workspacePath: () => workspace,
    accounts: () => ({
      accounts: [
        { id: null, label: 'Personal', available: true },
        { id: 'work', label: 'Work', available: workAvailable }
      ],
      workspaceAccountId
    }),
    prepareAccount: async (_provider, id) => (id === null ? home : target),
    heal: async () => ({
      outcome: 'completed',
      healedThreads: 1,
      missingThreads: 0,
      failedThreads: 0
    })
  })
  args = {
    agent: 'codex',
    sessionId,
    filePath,
    codexHome: home,
    executionHostId: 'local',
    workspaceId: 'folder:project'
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function open(accountId: string | null) {
  const preview = await planner.prepare({ ...args, preview: true })
  return planner.prepare({
    ...args,
    planToken: preview.resumePlan!.token,
    resumeAccountId: accountId
  })
}

it('does not guess last account from the storage home, and records it only after a successful open', async () => {
  const preview = await planner.prepare({ ...args, preview: true })
  expect(preview.resumePlan).toMatchObject({ needsChoice: true, lastAccountId: undefined })
  const prepared = await planner.prepare({
    ...args,
    planToken: preview.resumePlan!.token,
    resumeAccountId: null
  })
  expect(await ledger.list()).toEqual([])
  await planner.prepare({ ...args, commitToken: prepared.resumeReceipt })
  const next = await planner.prepare({ ...args, preview: true })
  expect(next.resumePlan).toMatchObject({ lastAccountId: null, needsChoice: false })
})

it('asks when the workspace differs, forks independently, groups the lineage and defaults to the last successful continuation', async () => {
  const first = await open(null)
  await planner.prepare({ ...args, commitToken: first.resumeReceipt })
  workspaceAccountId = 'work'
  const choice = await planner.prepare({ ...args, preview: true })
  expect(choice.resumePlan).toMatchObject({
    lastAccountId: null,
    workspaceAccountId: 'work',
    needsChoice: true
  })
  const fork = await planner.prepare({
    ...args,
    planToken: choice.resumePlan!.token,
    resumeAccountId: 'work'
  })
  expect(fork.substituteSessionId).not.toBe(sessionId)
  expect(await readFile(fork.substituteTranscriptPath!, 'utf8')).toContain(
    'Keep my original conversation'
  )
  await appendFile(fork.substituteTranscriptPath!, '\n')
  expect(await readFile(args.filePath, 'utf8')).toBe(original)
  expect(await readFile(join(root, 'work', 'auth.json'), 'utf8')).toBe('work-login')
  expect((await planner.prepare({ ...args, preview: true })).resumePlan?.lastAccountId).toBe(null)
  await planner.prepare({ ...args, commitToken: fork.resumeReceipt })
  const rows = await ledger.list()
  expect(rows.find((row) => row.sessionId === fork.substituteSessionId)).toMatchObject({
    rootSessionId: sessionId,
    parentSessionId: sessionId,
    accountId: 'work'
  })
  const latest = await planner.prepare({ ...args, preview: true })
  expect(latest.resumePlan).toMatchObject({ lastAccountId: 'work', needsChoice: false })
  const reopened = await planner.prepare({
    ...args,
    planToken: latest.resumePlan!.token,
    resumeAccountId: 'work'
  })
  expect(reopened.substituteSessionId).toBe(fork.substituteSessionId)
})

it('refuses unavailable accounts and prevents replaying a prepared choice', async () => {
  const preview = await planner.prepare({ ...args, preview: true })
  workAvailable = false
  await expect(
    planner.prepare({ ...args, planToken: preview.resumePlan!.token, resumeAccountId: 'work' })
  ).rejects.toThrow('unavailable')
  const prepared = await planner.prepare({
    ...args,
    planToken: preview.resumePlan!.token,
    resumeAccountId: null
  })
  expect(prepared.substituteSessionId).toBe(sessionId)
  await expect(
    planner.prepare({ ...args, planToken: preview.resumePlan!.token, resumeAccountId: null })
  ).rejects.toThrow('expired')
})
