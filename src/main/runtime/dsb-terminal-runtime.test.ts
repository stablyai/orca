import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { buildAgentPromptPasteBytes } from '../../shared/agent-prompt-injection'
import type { RuntimeTerminalSummary } from '../../shared/runtime-terminal-contracts'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/dsb',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/dsb',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

describe('manually started DeepSeek Build terminals', () => {
  afterEach(() => vi.useRealTimers())

  it('publishes title-only identity from captured release PTY bytes', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the store subset used by terminal observations.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    runtime.setPtyController({
      spawn: async () => ({ id: 'pty-dsb' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const terminal = await runtime.createTerminal('path:/tmp/worktree-a')
    const transcript = readFileSync(join(__dirname, '__fixtures__', 'dsb-6-9-0-folder.txt'), 'utf8')
    expect(transcript).toContain('\x1b]0;DeepSeek Build\x07')
    for (let offset = 0; offset < transcript.length; offset += 101) {
      runtime.onPtyData('pty-dsb', transcript.slice(offset, offset + 101), Date.now())
    }
    const listing = await runtime.listTerminals()
    expect(listing.terminals).toEqual([
      expect.objectContaining({ handle: terminal.handle, agentIdentity: 'dsb' })
    ])
  })

  it.each(['✦', '⏲', '◇', '✋'])(
    'preserves Build title and identity through OSC normalization with task glyph %s',
    async (glyph) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the store subset used by terminal observations.
      const runtime = new OrcaRuntimeService(makeStore() as never)
      runtime.setPtyController({
        spawn: async () => ({ id: 'pty-dsb' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const terminal = await runtime.createTerminal('path:/tmp/worktree-a')
      const title = `⠋ - Review ${glyph} rendering - DeepSeek Build`
      runtime.onPtyData('pty-dsb', `\x1b]0;${title}\x07`, Date.now())
      const listing = await runtime.listTerminals()
      expect(listing.terminals).toEqual([
        expect.objectContaining({ handle: terminal.handle, agentIdentity: 'dsb', title })
      ])
    }
  )

  it('publishes observed DSB identity and sends a prompt with generic input behavior', async () => {
    vi.useFakeTimers()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the store subset exercised by terminal recognition and prompt submission.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const writes: string[] = []
    runtime.setPtyController({
      spawn: async () => ({ id: 'pty-dsb' }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          runtime.onPtyData('pty-dsb', '\x1b]0;⠋ - Review Codex - DeepSeek Build\x07', Date.now())
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'dsb'
    })
    const terminal = await runtime.createTerminal('path:/tmp/worktree-a')
    runtime.onPtyData('pty-dsb', '\x1b]0;DeepSeek Build\x07', Date.now())
    await runtime.refreshPtyForegroundAgentFromController('pty-dsb')
    const listing = await runtime.listTerminals()
    expectTypeOf<RuntimeTerminalSummary['agentIdentity']>().toEqualTypeOf<
      TerminalAgent | undefined
    >()
    expect(listing.terminals).toEqual([
      expect.objectContaining({ handle: terminal.handle, agentIdentity: 'dsb' })
    ])
    expect(JSON.parse(JSON.stringify(listing)).terminals[0].agentIdentity).toBe('dsb')

    const submission = runtime.sendTerminalAgentPrompt(terminal.handle, 'review this', {
      inputKind: 'driving',
      leadLine: 'Please review'
    })
    await Promise.all([
      expect(submission).resolves.toMatchObject({ accepted: true }),
      vi.runAllTimersAsync()
    ])
    expect(writes).toEqual([buildAgentPromptPasteBytes('review this', 'Please review'), '\r'])
  })
})
