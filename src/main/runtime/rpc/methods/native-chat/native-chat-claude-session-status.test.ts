import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noteClaudeSessionWindow } from '../../../../native-chat/claude-session-window-store'
import type { RpcContext } from '../../core'
import { NATIVE_CHAT_METHODS } from './native-chat'

function statusHandler(): (params: unknown, ctx: RpcContext) => Promise<unknown> {
  const method = NATIVE_CHAT_METHODS.find((m) => m.name === 'nativeChat.claudeSessionStatus')
  if (!method) {
    throw new Error('claudeSessionStatus method not registered')
  }
  return method.handler as (params: unknown, ctx: RpcContext) => Promise<unknown>
}

function context(): RpcContext {
  const runtime = { getAgentProviderSessionRows: () => [] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method uses only the hook rows.
  return { runtime: runtime as unknown as RpcContext['runtime'], clientKind: 'mobile' }
}

const TRANSCRIPT = [
  JSON.stringify({
    type: 'api-request',
    querySource: 'repl_main_thread',
    params: { output_config: { effort: 'high' } }
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 340000,
        output_tokens: 1
      }
    }
  }),
  ''
].join('\n')

describe('nativeChat.claudeSessionStatus', () => {
  let dir: string
  let transcriptPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-status-rpc-'))
    transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, TRANSCRIPT)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns no status for other agents', async () => {
    await expect(
      statusHandler()({ agent: 'codex', sessionId: 'other-agent', transcriptPath }, context())
    ).resolves.toEqual({ status: null })
  })

  it('joins transcript facts with the statusline window', async () => {
    noteClaudeSessionWindow('with-window', 1000000)
    await expect(
      statusHandler()({ agent: 'claude', sessionId: 'with-window', transcriptPath }, context())
    ).resolves.toEqual({
      status: {
        model: 'claude-opus-5-5',
        effort: 'high',
        usedTokens: 340000,
        windowTokens: 1000000,
        compactions: 0
      }
    })
  })

  it('leaves the window unknown without a statusline report', async () => {
    await expect(
      statusHandler()({ agent: 'claude', sessionId: 'no-window', transcriptPath }, context())
    ).resolves.toMatchObject({ status: { usedTokens: 340000, windowTokens: null } })
  })

  it('returns no status when the transcript cannot be found', async () => {
    await expect(
      statusHandler()(
        { agent: 'claude', sessionId: 'gone', transcriptPath: join(dir, 'missing.jsonl') },
        context()
      )
    ).resolves.toEqual({ status: null })
  })
})
