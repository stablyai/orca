import { describe, expect, it } from 'vitest'
import { parseGeminiJsonDocument } from './gemini-usage-document-parser'
import { parseGeminiUsageRecord, type GeminiUsageParseContext } from './gemini-usage-record-parser'

describe('gemini-usage-record-parser', () => {
  it('parses Gemini CLI JSONL message records', () => {
    const context: GeminiUsageParseContext = {
      sessionId: 'session-123',
      sessionCwd: null,
      currentCwd: null,
      currentModel: null,
      previousTotals: null
    }

    // User prompt
    expect(
      parseGeminiUsageRecord(
        JSON.stringify({
          type: 'user',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/home/user/workspace/my-app',
          content: 'Refactor database queries'
        }),
        context
      )
    ).toBeNull()

    expect(context.currentCwd).toBe('/home/user/workspace/my-app')

    // Gemini assistant response
    const event = parseGeminiUsageRecord(
      JSON.stringify({
        type: 'gemini',
        timestamp: '2026-05-01T10:00:15.000Z',
        model: 'gemini-2.5-pro',
        content: 'I updated the query methods',
        tokens: {
          input: 1200,
          cached: 400,
          output: 300,
          reasoning: 50,
          total: 1500
        }
      }),
      context
    )

    expect(event).not.toBeNull()
    expect(event?.sessionId).toBe('session-123')
    expect(event?.model).toBe('gemini-2.5-pro')
    expect(event?.cwd).toBe('/home/user/workspace/my-app')
    expect(event?.inputTokens).toBe(1200)
    expect(event?.cachedInputTokens).toBe(400)
    expect(event?.outputTokens).toBe(300)
    expect(event?.reasoningOutputTokens).toBe(50)
    expect(event?.totalTokens).toBe(1550)
  })

  it('parses Antigravity transcript lines with usage records', () => {
    const context: GeminiUsageParseContext = {
      sessionId: 'antigravity-abc',
      sessionCwd: '/home/user/project',
      currentCwd: null,
      currentModel: null,
      previousTotals: null
    }

    const event = parseGeminiUsageRecord(
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-05-01T11:00:00.000Z',
        model: 'gemini-3.0-pro',
        usage: {
          promptTokenCount: 2000,
          cachedContentTokenCount: 800,
          candidatesTokenCount: 600,
          thoughtsTokenCount: 150
        }
      }),
      context
    )

    expect(event).not.toBeNull()
    expect(event?.sessionId).toBe('antigravity-abc')
    expect(event?.model).toBe('gemini-3.0-pro')
    expect(event?.cwd).toBe('/home/user/project')
    expect(event?.inputTokens).toBe(2000)
    expect(event?.cachedInputTokens).toBe(800)
    expect(event?.outputTokens).toBe(600)
    expect(event?.reasoningOutputTokens).toBe(150)
    expect(event?.totalTokens).toBe(2750)
  })

  it('parses whole Gemini JSON session documents', () => {
    const context: GeminiUsageParseContext = {
      sessionId: 'doc-session',
      sessionCwd: null,
      currentCwd: null,
      currentModel: null,
      previousTotals: null
    }

    const jsonDoc = JSON.stringify({
      sessionId: 'custom-session-id',
      cwd: '/workspace/project-one',
      startTime: '2026-05-01T10:00:00.000Z',
      messages: [
        {
          type: 'user',
          timestamp: '2026-05-01T10:00:00.000Z',
          content: 'Hello'
        },
        {
          type: 'gemini',
          timestamp: '2026-05-01T10:00:10.000Z',
          model: 'gemini-2.5-flash',
          content: 'Hello! How can I help?',
          tokens: {
            input: 500,
            output: 100,
            cached: 0
          }
        },
        {
          type: 'gemini',
          timestamp: '2026-05-01T10:01:00.000Z',
          model: 'gemini-2.5-flash',
          content: 'Here is your answer',
          tokens: {
            input: 800,
            output: 200,
            cached: 400
          }
        }
      ]
    })

    const events = parseGeminiJsonDocument(jsonDoc, context)
    expect(events).toHaveLength(2)
    expect(events[0]?.sessionId).toBe('custom-session-id')
    expect(events[0]?.model).toBe('gemini-2.5-flash')
    expect(events[0]?.cwd).toBe('/workspace/project-one')
    expect(events[0]?.inputTokens).toBe(500)
    expect(events[0]?.outputTokens).toBe(100)

    expect(events[1]?.inputTokens).toBe(800)
    expect(events[1]?.cachedInputTokens).toBe(400)
    expect(events[1]?.outputTokens).toBe(200)
  })

  it('handles corrupted JSON, comments, and empty lines safely', () => {
    const context: GeminiUsageParseContext = {
      sessionId: 's1',
      sessionCwd: null,
      currentCwd: null,
      currentModel: null,
      previousTotals: null
    }

    expect(parseGeminiUsageRecord('', context)).toBeNull()
    expect(parseGeminiUsageRecord('   ', context)).toBeNull()
    expect(parseGeminiUsageRecord('# comment line', context)).toBeNull()
    expect(parseGeminiUsageRecord('// comment line', context)).toBeNull()
    expect(parseGeminiUsageRecord('{ invalid json', context)).toBeNull()
    expect(parseGeminiUsageRecord('42', context)).toBeNull()
    expect(
      parseGeminiUsageRecord(
        JSON.stringify({ no_tokens: true, timestamp: '2026-05-01T10:00:00Z' }),
        context
      )
    ).toBeNull()
  })
})
