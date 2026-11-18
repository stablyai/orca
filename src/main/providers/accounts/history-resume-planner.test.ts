import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
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
let failIndex = false
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-resume-plan-')))
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
  failIndex = false
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
      failedThreads: failIndex ? 1 : 0
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

it('keeps duplicate imported IDs in separate transcript lineages', async () => {
  const imported = join(
    root,
    'work',
    'sessions',
    '2026',
    '11',
    '17',
    `rollout-2026-11-17T10-00-00-${sessionId}.jsonl`
  )
  await mkdir(join(root, 'work', 'sessions', '2026', '11', '17'), { recursive: true })
  await writeFile(imported, original)
  const first = await open(null)
  await planner.prepare({ ...args, commitToken: first.resumeReceipt })
  const preview = await planner.prepare({ ...args, filePath: imported, preview: true })
  const selected = await planner.prepare({
    ...args,
    filePath: imported,
    planToken: preview.resumePlan!.token,
    resumeAccountId: 'work'
  })
  await planner.prepare({ ...args, commitToken: selected.resumeReceipt })
  expect((await planner.prepare({ ...args, preview: true })).resumePlan?.lastAccountId).toBeNull()
  expect(
    (await planner.prepare({ ...args, filePath: imported, preview: true })).resumePlan
      ?.lastAccountId
  ).toBe('work')
  expect(await ledger.list()).toHaveLength(2)
})

it('repairs an unindexed continuation on retry instead of publishing another copy', async () => {
  failIndex = true
  await expect(open('work')).rejects.toThrow('could not be indexed')
  const pending = (await ledger.list()).find((entry) => entry.preparedAccountId === 'work')!
  expect(await readFile(pending.filePath, 'utf8')).toContain('Keep my original conversation')
  failIndex = false
  const recovered = await open('work')
  expect(recovered.substituteSessionId).toBe(pending.sessionId)
  expect(recovered.substituteTranscriptPath).toBe(pending.filePath)
  expect(await readFile(args.filePath, 'utf8')).toBe(original)
})

it('keeps a validated resume choice after commit even when the workspace account changes', async () => {
  const opened = await open(null)
  await planner.prepare({ ...args, commitToken: opened.resumeReceipt })
  workspaceAccountId = 'work'
  expect(await planner.accountForReceipt(opened.resumeReceipt!, 'codex', args.workspaceId)).toEqual(
    { accountId: null, home: join(root, 'system') }
  )
  await expect(
    planner.accountForReceipt(opened.resumeReceipt!, 'codex', 'folder:another')
  ).rejects.toThrow('another workspace')
})
