import { describe, expect, it, vi } from 'vitest'
import { BOT_CREATE_HANDLERS } from './bot-create'

type RecordedCall = {
  method: string
  params: Record<string, unknown> | undefined
}

function makeContext(entries: Record<string, string | boolean>, calls: RecordedCall[]) {
  return {
    flags: new Map<string, string | boolean>(Object.entries(entries)),
    json: true,
    client: {
      call: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params })
        return {
          result: {
            bot: { id: 'bot-1', name: String(params?.name ?? 'Bot'), folder: '/tmp/bot' }
          }
        }
      }
    }
  } as never
}

describe('orca bot create', () => {
  it('calls bots.create with name, agent and seed when --offer is omitted', async () => {
    const calls: RecordedCall[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await BOT_CREATE_HANDLERS['bot create'](
        makeContext(
          {
            name: 'Triage',
            purpose: 'Triage incoming bugs.',
            agent: 'codex',
            watches: 'GitHub issues',
            does: 'Summarizes new bug reports',
            reports: 'Here, weekday mornings'
          },
          calls
        )
      )
    } finally {
      log.mockRestore()
    }
    expect(calls).toEqual([
      {
        method: 'bots.create',
        params: {
          name: 'Triage',
          agent: 'codex',
          seed: {
            purpose: 'Triage incoming bugs.',
            watches: 'GitHub issues',
            does: 'Summarizes new bug reports',
            reports: 'Here, weekday mornings'
          }
        }
      }
    ])
  })

  it('expands --template into seed, avatar and fromTemplate when creating directly', async () => {
    const calls: RecordedCall[] = []
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await BOT_CREATE_HANDLERS['bot create'](makeContext({ template: 'pr-review' }, calls))
    } finally {
      log.mockRestore()
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('bots.create')
    expect(calls[0]?.params).toMatchObject({
      name: 'Pull request review',
      fromTemplate: { id: 'pr-review' },
      seed: { templateId: 'pr-review' }
    })
  })

  it('rejects unknown --agent values and --agent combined with --offer', async () => {
    await expect(
      BOT_CREATE_HANDLERS['bot create'](
        makeContext({ name: 'Triage', purpose: 'Triage bugs.', agent: 'not-an-agent' }, [])
      )
    ).rejects.toThrow(/--agent is one of:/)

    await expect(
      BOT_CREATE_HANDLERS['bot create'](
        makeContext({ offer: true, name: 'Triage', purpose: 'Triage bugs.', agent: 'codex' }, [])
      )
    ).rejects.toThrow(/without --offer/)
  })
})
