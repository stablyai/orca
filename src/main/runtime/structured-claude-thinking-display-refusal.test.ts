// A real child, through the real SDK connection, refusing the thinking-display flag the way an
// older Claude CLI does: commander's message and exit code 1.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from '../claude/claude-structured-launch-resolution'
import { fakeClaude } from '../claude/claude-structured-session-test-support'
import { createClaudeThinkingDisplaySupport } from '../claude/claude-thinking-display-support'
import { openClaudeConnectionOf } from './structured-claude-runtime-adapter'

const FAKE_CLI = join(
  __dirname,
  '..',
  'claude',
  '__fixtures__',
  'claude-agent-sdk-scripted-cli.mjs'
)
const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function startRefusing(stderr: string) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-thinking-display-'))
  scratchDirs.push(dir)
  const scenarioPath = join(dir, 'scenario.json')
  writeFileSync(scenarioPath, JSON.stringify({ steps: [{ stderr }, { exit: 1 }] }))
  const env = { PATH: process.env.PATH ?? '', ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath }
  const probe = vi.fn(async () => '2.1.280')
  const support = createClaudeThinkingDisplaySupport({
    probe,
    keyOf: async (command, cwd) => `${command}\n${cwd}`,
    budgetMs: 1_000,
    now: () => performance.now()
  })
  const flag = await support.argsFor({ command: FAKE_CLI, cwd: dir, env })
  const { openConnection } = openClaudeConnectionOf({ claudeThinkingDisplay: support })
  let exited: Error | null = null
  const connection = await openConnection!(
    {
      pathToClaudeCodeExecutable: FAKE_CLI,
      options: {
        ...CLAUDE_STRUCTURED_BASE_OPTIONS,
        extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, ...flag }
      },
      cwd: dir,
      env
    },
    { onExit: (error) => (exited = error) }
  )
  await vi.waitFor(() => expect(exited).not.toBeNull(), { timeout: 10_000 })
  await connection.close()
  return { support, probe, flag, launch: { command: FAKE_CLI, cwd: dir, env } }
}

describe('a Claude CLI that refuses the thinking-display flag', () => {
  it('fails that one start as today, and the next launch skips the flag', async () => {
    const { support, probe, flag, launch } = await startRefusing(
      "error: unknown option '--thinking-display'\n"
    )
    expect(flag).toEqual({ 'thinking-display': 'summarized' })
    await vi.waitFor(async () => expect(await support.argsFor(launch)).toEqual({}))
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('hands the session whether its close was the one Orca began', async () => {
    const claude = fakeClaude()
    const support = createClaudeThinkingDisplaySupport({
      probe: async () => '2.1.280',
      keyOf: async () => null,
      budgetMs: 1_000,
      now: () => performance.now()
    })
    const { openConnection } = openClaudeConnectionOf({
      claudeThinkingDisplay: support,
      openClaudeConnection: claude.openConnection
    })
    const onExit = vi.fn()
    await openConnection!(
      { pathToClaudeCodeExecutable: FAKE_CLI, options: {}, cwd: '/w' },
      { onExit }
    )
    const exited = new Error('closed')
    claude.connections[0]!.handlers.onExit?.(exited, { expected: true })
    // Without it, a Stop's own exit would read as the child exiting on its own.
    expect(onExit).toHaveBeenCalledWith(exited, { expected: true })
  })

  it('records nothing when the start failed for another reason', async () => {
    const { support, launch } = await startRefusing('claude: not signed in\n')
    await expect(support.argsFor(launch)).resolves.toEqual({ 'thinking-display': 'summarized' })
  })
})
