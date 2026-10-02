import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_ROOM_CONTEXT } from '../../../shared/room-context'
import { parseRoomContextRecord, readRoomContext } from './context-reader'

describe('room context records', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('reads the current Codex window, not cumulative session spend', () => {
    expect(
      parseRoomContextRecord(
        'codex',
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 900_000 },
              last_token_usage: { total_tokens: 120_000 },
              model_context_window: 258_400
            }
          }
        })
      )
    ).toEqual({ usedTokens: 120_000, maxTokens: 258_400 })
  })

  it('reads Claude cache-bearing input and Grok durable metadata', () => {
    expect(
      parseRoomContextRecord(
        'claude',
        JSON.stringify({
          type: 'assistant',
          message: {
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30
            }
          }
        })
      )
    ).toEqual({ usedTokens: 60, maxTokens: null })
    expect(
      parseRoomContextRecord('grok', JSON.stringify({ params: { _meta: { totalTokens: 42_000 } } }))
    ).toEqual({ usedTokens: 42_000, maxTokens: null })
  })

  it('reads Claude Fast mode from its local command confirmation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-claude-fast-mode-'))
    directories.push(directory)
    const transcriptPath = join(directory, 'session.jsonl')
    writeFileSync(
      transcriptPath,
      [
        {
          type: 'assistant',
          message: { usage: { input_tokens: 10 } }
        },
        {
          type: 'user',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          message: {
            role: 'user',
            content: '<local-command-stdout>Fast mode OFF</local-command-stdout>'
          }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )

    await expect(
      readRoomContext(
        'claude',
        { key: 'session_id', id: 'session', transcriptPath },
        { ...EMPTY_ROOM_CONTEXT, observedAt: Date.now() }
      )
    ).resolves.toMatchObject({ fastMode: false, usedTokens: 10 })
  })

  it('marks native compaction complete when provider usage drops', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-context-'))
    directories.push(directory)
    const transcriptPath = join(directory, 'rollout.jsonl')
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 20_000 }, model_context_window: 258_400 }
        }
      })}\n`
    )
    const context = await readRoomContext(
      'codex',
      { key: 'session_id', id: 'session', transcriptPath },
      {
        ...EMPTY_ROOM_CONTEXT,
        usedTokens: 120_000,
        compaction: 'running',
        compactionUpdatedAt: 1
      }
    )
    expect(context).toMatchObject({
      usedTokens: 20_000,
      maxTokens: 258_400,
      compaction: 'completed'
    })
  })

  it('reads Codex Fast mode alongside the latest turn context', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-fast-mode-'))
    directories.push(directory)
    const transcriptPath = join(directory, 'rollout.jsonl')
    const timestamp = new Date(Date.now() + 60_000).toISOString()
    writeFileSync(
      transcriptPath,
      [
        {
          timestamp,
          type: 'event_msg',
          payload: {
            type: 'thread_settings_applied',
            thread_settings: { service_tier: 'priority' }
          }
        },
        {
          timestamp,
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', effort: 'high' }
        },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { total_tokens: 20_000 }, model_context_window: 258_400 }
          }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )

    await expect(
      readRoomContext(
        'codex',
        { key: 'session_id', id: 'session', transcriptPath },
        EMPTY_ROOM_CONTEXT
      )
    ).resolves.toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      fastMode: true,
      usedTokens: 20_000
    })
  })

  it('never reverts reconfigured options to older transcript rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-options-'))
    directories.push(directory)
    const transcriptPath = join(directory, 'rollout.jsonl')
    const usageLine = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: 20_000 }, model_context_window: 258_400 }
      }
    })
    // The last turn before reconfiguration still names the old model.
    writeFileSync(
      transcriptPath,
      `${[
        {
          type: 'event_msg',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          payload: {
            type: 'thread_settings_applied',
            thread_settings: { service_tier: 'priority' }
          }
        },
        {
          type: 'turn_context',
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          payload: { model: 'gpt-5.6-luna', effort: 'medium' }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n${usageLine}\n`
    )
    const reconfigured = await readRoomContext(
      'codex',
      { key: 'session_id', id: 'session', transcriptPath },
      {
        ...EMPTY_ROOM_CONTEXT,
        model: 'gpt-5.6-sol',
        effort: 'high',
        observedAt: Date.now()
      }
    )
    expect(reconfigured).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      fastMode: true,
      usedTokens: 20_000
    })

    // A turn newer than the last observation moves the context forward.
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'turn_context',
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        payload: { model: 'gpt-5.6-sol', effort: 'xhigh' }
      })}\n${usageLine}\n`
    )
    await expect(
      readRoomContext('codex', { key: 'session_id', id: 'session', transcriptPath }, reconfigured)
    ).resolves.toMatchObject({ model: 'gpt-5.6-sol', effort: 'xhigh' })
  })

  it('resolves Grok context from its provider session id', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-room-grok-context-'))
    directories.push(directory)
    const previousGrokHome = process.env.GROK_HOME
    process.env.GROK_HOME = directory
    const sessionDirectory = join(directory, 'sessions', 'project', 'grok-session')
    mkdirSync(sessionDirectory, { recursive: true })
    writeFileSync(join(sessionDirectory, 'chat_history.jsonl'), '{}\n')
    writeFileSync(
      join(sessionDirectory, 'updates.jsonl'),
      `${JSON.stringify({ params: { _meta: { totalTokens: 42_000 } } })}\n`
    )

    try {
      await expect(
        readRoomContext('grok', { key: 'session_id', id: 'grok-session' }, EMPTY_ROOM_CONTEXT)
      ).resolves.toMatchObject({ usedTokens: 42_000, source: 'provider' })
    } finally {
      if (previousGrokHome === undefined) {
        delete process.env.GROK_HOME
      } else {
        process.env.GROK_HOME = previousGrokHome
      }
    }
  })
})
