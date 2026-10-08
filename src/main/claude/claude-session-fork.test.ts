import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { forkClaudeSession } from './claude-session-fork'
import { buildClaudeSessionForkWorkerEntry } from './claude-session-fork-worker-test-support'
import {
  CLAUDE_TWO_TURN_FIRST_ANSWER,
  CLAUDE_TWO_TURN_SESSION_ID,
  CLAUDE_TWO_TURN_TRANSCRIPT
} from './claude-two-turn-transcript.test-fixture'

const TRANSCRIPT = resolve(CLAUDE_TWO_TURN_TRANSCRIPT)

const roots: string[] = []
let worker: Awaited<ReturnType<typeof buildClaudeSessionForkWorkerEntry>>

beforeAll(async () => {
  worker = await buildClaudeSessionForkWorkerEntry()
})

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
afterAll(() => worker.dispose())

function accountWithTranscript(): { configDir: string; projectDir: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'claude-fork-account-'))
  roots.push(configDir)
  const projectDir = join(configDir, 'projects', '-workspace')
  mkdirSync(projectDir, { recursive: true })
  copyFileSync(TRANSCRIPT, join(projectDir, `${CLAUDE_TWO_TURN_SESSION_ID}.jsonl`))
  return { configDir, projectDir }
}

function conversation(path: string): string[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === 'user' || row.type === 'assistant')
    .map((row) => `${row.type}:${row.message.content[0].type}`)
}

it('copies the conversation through the chosen entry, in the account it was given', async () => {
  const { configDir, projectDir } = accountWithTranscript()
  const parentPath = join(projectDir, `${CLAUDE_TWO_TURN_SESSION_ID}.jsonl`)
  const before = readFileSync(parentPath, 'utf8')
  const ambient = process.env.CLAUDE_CONFIG_DIR

  const child = await forkClaudeSession(
    {
      claudeConfigDir: configDir,
      providerSessionId: CLAUDE_TWO_TURN_SESSION_ID,
      upToMessageId: CLAUDE_TWO_TURN_FIRST_ANSWER
    },
    worker.entry
  )

  expect(child).not.toBe(CLAUDE_TWO_TURN_SESSION_ID)
  expect(readdirSync(projectDir).sort()).toEqual(
    [`${CLAUDE_TWO_TURN_SESSION_ID}.jsonl`, `${child}.jsonl`].sort()
  )
  // The first turn whole, and nothing of the second.
  expect(conversation(join(projectDir, `${child}.jsonl`))).toEqual([
    'user:text',
    'assistant:thinking',
    'assistant:text'
  ])
  expect(readFileSync(parentPath, 'utf8')).toBe(before)
  expect(process.env.CLAUDE_CONFIG_DIR).toBe(ambient)
})

it('fails for an entry the conversation does not hold, and writes no copy', async () => {
  const { configDir, projectDir } = accountWithTranscript()

  await expect(
    forkClaudeSession(
      {
        claudeConfigDir: configDir,
        providerSessionId: CLAUDE_TWO_TURN_SESSION_ID,
        upToMessageId: 'not-an-entry'
      },
      worker.entry
    )
  ).rejects.toThrow('not found in session')
  expect(readdirSync(projectDir)).toEqual([`${CLAUDE_TWO_TURN_SESSION_ID}.jsonl`])
})

it('does not find a conversation that lives in another account', async () => {
  accountWithTranscript()
  const otherAccount = mkdtempSync(join(tmpdir(), 'claude-fork-other-'))
  roots.push(otherAccount)

  await expect(
    forkClaudeSession(
      {
        claudeConfigDir: otherAccount,
        providerSessionId: CLAUDE_TWO_TURN_SESSION_ID,
        upToMessageId: CLAUDE_TWO_TURN_FIRST_ANSWER
      },
      worker.entry
    )
  ).rejects.toThrow('not found')
})
