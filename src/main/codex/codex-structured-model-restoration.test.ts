import { describe, expect, it, vi } from 'vitest'
import { resolveCodexAcquiredSessionOptions } from './codex-structured-model-restoration'

function listedModel(input: {
  id: string
  isDefault?: boolean
  defaultEffort?: string
  efforts?: string[]
}): Record<string, unknown> {
  return {
    model: input.id,
    isDefault: input.isDefault ?? false,
    supportedReasoningEfforts: (input.efforts ?? []).map((reasoningEffort) => ({
      reasoningEffort
    })),
    ...(input.defaultEffort ? { defaultReasoningEffort: input.defaultEffort } : {})
  }
}

function resolveWith(input: {
  options?: Readonly<Record<string, string>>
  opened?: { model?: string; effort?: string }
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}) {
  return resolveCodexAcquiredSessionOptions({
    connection: { request: input.request } as never,
    options: input.options,
    opened: {
      threadId: 'thread-1',
      historyPath: null,
      ...input.opened
    },
    timeoutMs: 456
  })
}

describe('Codex structured model restoration', () => {
  it('recovers a refused restored pick using the uniquely listed default', async () => {
    const result = await resolveWith({
      options: {
        model: 'retired-id',
        effort: 'high',
        approvalPolicy: 'never',
        personality: 'friendly'
      },
      opened: { model: 'reported-good', effort: 'medium' },
      request: vi.fn(async () => ({
        data: [
          listedModel({ id: 'reported-good', efforts: ['medium'] }),
          listedModel({
            id: 'listed-default',
            isDefault: true,
            defaultEffort: 'low',
            efforts: ['low', 'high']
          })
        ],
        nextCursor: null
      }))
    })

    expect(Object.fromEntries(result.options)).toEqual({
      approvalPolicy: 'never',
      personality: 'friendly',
      model: 'listed-default',
      effort: 'low'
    })
    expect(result.reportedOptions).toEqual({ model: 'reported-good', effort: 'medium' })
    expect(result.notice).toContain('retired-id')
    expect(result.notice).toContain('listed-default')
    expect(result.notice).toContain('Orca selected the provider-listed default')
  })

  it('recovers an unlisted resumed report with no restored model', async () => {
    const result = await resolveWith({
      opened: { model: 'retired-resume', effort: 'high' },
      request: vi.fn(async () => ({
        data: [listedModel({ id: 'listed-default', isDefault: true })],
        nextCursor: null
      }))
    })

    expect(Object.fromEntries(result.options)).toEqual({ model: 'listed-default' })
    expect(result.reportedOptions).toEqual({})
    expect(result.notice).toContain('retired-resume')
  })

  it('keeps a valid restored choice when the opened report is unlisted', async () => {
    const result = await resolveWith({
      options: { model: 'account-private', effort: 'high', approvalPolicy: 'never' },
      opened: { model: 'retired-resume', effort: 'low' },
      request: vi.fn(async () => ({
        data: [
          listedModel({ id: 'account-private', efforts: ['high'] }),
          listedModel({ id: 'listed-default', isDefault: true })
        ],
        nextCursor: null
      }))
    })

    expect(Object.fromEntries(result.options)).toEqual({
      model: 'account-private',
      effort: 'high',
      approvalPolicy: 'never'
    })
    expect(result.reportedOptions).toEqual({})
    expect(result.notice).toContain('existing restored choice "account-private"')
    expect(result.notice).not.toContain('Orca selected the provider-listed default')
  })

  it.each([
    {
      name: 'method failure',
      request: async () => {
        throw new Error('method not found')
      },
      calls: 1
    },
    {
      name: 'later-page failure',
      request: async (_method: string, params?: Record<string, unknown>) => {
        if (params?.cursor) {
          throw new Error('page unavailable')
        }
        return { data: [listedModel({ id: 'partial-only' })], nextCursor: 'page-2' }
      },
      calls: 2
    },
    { name: 'malformed result', request: async () => 'malformed', calls: 1 },
    { name: 'empty result', request: async () => ({ data: [], nextCursor: null }), calls: 1 },
    {
      name: 'bounded incomplete result',
      request: async () => ({ data: [listedModel({ id: 'partial-only' })], nextCursor: 'more' }),
      calls: 20
    }
  ])('admits unknown picks when model enumeration has $name', async ({ request, calls }) => {
    const routed = vi.fn(request)
    const result = await resolveWith({
      options: { model: 'restored-unknown', effort: 'high' },
      opened: { model: 'reported-unknown', effort: 'medium' },
      request: routed
    })

    expect(Object.fromEntries(result.options)).toEqual({
      model: 'restored-unknown',
      effort: 'high'
    })
    expect(result.reportedOptions).toEqual({ model: 'reported-unknown', effort: 'medium' })
    expect(result.notice).toBeUndefined()
    expect(routed).toHaveBeenCalledTimes(calls)
  })

  it.each([
    {
      name: 'missing',
      rows: [listedModel({ id: 'listed-nondefault' })]
    },
    {
      name: 'ambiguous',
      rows: [
        listedModel({ id: 'default-one', isDefault: true }),
        listedModel({ id: 'default-two', isDefault: true })
      ]
    }
  ])('preserves the pick and explains a $name provider default', async ({ rows }) => {
    const result = await resolveWith({
      options: { model: 'retired-id', effort: 'high', approvalPolicy: 'never' },
      opened: { model: 'retired-report', effort: 'low' },
      request: vi.fn(async () => ({ data: rows, nextCursor: null }))
    })

    expect(Object.fromEntries(result.options)).toEqual({
      model: 'retired-id',
      effort: 'high',
      approvalPolicy: 'never'
    })
    expect(result.reportedOptions).toEqual({ model: 'retired-report', effort: 'low' })
    expect(result.notice).toContain('did not identify a unique provider default')
    expect(result.notice).toContain('retired-id')
    expect(result.notice).toContain('retired-report')
  })

  it('uses one connection-local catalog snapshot for both candidates', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
      params?.cursor
        ? { data: [listedModel({ id: 'listed-default', isDefault: true })], nextCursor: null }
        : { data: [listedModel({ id: 'account-private' })], nextCursor: 'page-2' }
    )
    const result = await resolveWith({
      options: { model: 'account-private' },
      opened: { model: 'retired-report' },
      request
    })

    expect(Object.fromEntries(result.options)).toEqual({ model: 'account-private' })
    expect(result.reportedOptions).toEqual({})
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not substitute a seed default for an account-private default', async () => {
    const result = await resolveWith({
      options: { model: 'gpt-5.6-sol', effort: 'high' },
      request: vi.fn(async () => ({
        data: [
          listedModel({
            id: 'account-private-default',
            isDefault: true,
            defaultEffort: 'medium',
            efforts: ['medium']
          })
        ],
        nextCursor: null
      }))
    })

    expect(Object.fromEntries(result.options)).toEqual({
      model: 'account-private-default',
      effort: 'medium'
    })
  })

  it('does not carry an unadvertised default effort to the replacement', async () => {
    const result = await resolveWith({
      options: { model: 'retired-id', effort: 'high' },
      request: vi.fn(async () => ({
        data: [
          listedModel({
            id: 'listed-default',
            isDefault: true,
            defaultEffort: 'ultra',
            efforts: ['medium']
          })
        ],
        nextCursor: null
      }))
    })

    expect(Object.fromEntries(result.options)).toEqual({ model: 'listed-default' })
  })

  it('never carries an empty model into turn options', async () => {
    const result = await resolveWith({
      options: { model: '', approvalPolicy: 'never' },
      request: vi.fn(async () => ({
        data: [listedModel({ id: 'listed-default', isDefault: true })],
        nextCursor: null
      }))
    })

    expect(Object.fromEntries(result.options)).toEqual({ approvalPolicy: 'never' })
    expect(result.notice).toBeUndefined()
  })

  it('bounds exceptionally long model ids in notices', async () => {
    const result = await resolveWith({
      options: { model: `retired-${'x'.repeat(10_000)}` },
      request: vi.fn(async () => ({
        data: [listedModel({ id: `default-${'y'.repeat(10_000)}`, isDefault: true })],
        nextCursor: null
      }))
    })

    expect(result.notice?.length).toBeLessThan(500)
    expect(result.notice).toContain('…')
  })
})
