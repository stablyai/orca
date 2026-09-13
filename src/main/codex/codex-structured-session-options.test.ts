import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  applyCodexStructuredSessionOption,
  codexCatalogAdmitsModel,
  readCodexStructuredSessionOptions,
  reportedCodexThreadOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexSession } from './codex-structured-session-state'

function optionSession(request: CodexAppServerConnection['request']): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    requestedClose: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    historyPath: null,
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(),
    reportedOptions: { model: 'gpt-live', effort: 'high' },
    turnIdWaiters: [],
    translator: null
  }
}

describe('structured Codex session options', () => {
  it('filters restored records to recognized turn options', () => {
    expect(
      Object.fromEntries(
        restoredCodexSessionOptions(
          {
            model: 'gpt-live',
            effort: 'high',
            threadId: 'thread-injected',
            input: 'input-injected'
          },
          null
        )
      )
    ).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('does not fabricate a provider row for an unlisted current model', async () => {
    const request = vi.fn(async () => ({
      data: [{ model: 'listed-default', isDefault: true }],
      nextCursor: null
    }))

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'retired-id' }
      })
    ).resolves.toEqual({
      models: [{ id: 'listed-default', label: 'listed-default', isDefault: true, efforts: [] }],
      current: { model: 'retired-id' }
    })
  })

  it('hydrates paged provider models and their supported efforts', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
      params?.cursor
        ? {
            data: [
              {
                model: 'gpt-second',
                displayName: 'GPT Second',
                description: 'Fast',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Quick reasoning' }
                ],
                defaultReasoningEffort: 'low',
                isDefault: false
              }
            ],
            nextCursor: null
          }
        : {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: 'page-2'
          }
    )

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'gpt-live', effort: 'medium' }
      })
    ).resolves.toEqual({
      models: [
        {
          id: 'gpt-live',
          label: 'GPT Live',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium', description: 'Balanced' },
            { value: 'high', label: 'High', description: 'Deep reasoning' }
          ]
        },
        {
          id: 'gpt-second',
          label: 'GPT Second',
          description: 'Fast',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [{ value: 'low', label: 'Low', description: 'Quick reasoning' }]
        }
      ],
      current: { model: 'gpt-live', effort: 'medium' }
    })
    expect(request).toHaveBeenNthCalledWith(
      2,
      'model/list',
      { limit: 100, includeHidden: false, cursor: 'page-2' },
      { timeoutMs: undefined }
    )
  })

  it('uses every model-list page as membership evidence', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
      params?.cursor
        ? { data: [{ model: 'page-two-private' }], nextCursor: null }
        : { data: [{ model: 'listed-default', isDefault: true }], nextCursor: 'page-2' }
    )

    const catalog = await readCodexStructuredSessionOptions({
      connection: { request } as never,
      current: { model: 'page-two-private' },
      timeoutMs: 321
    })

    expect(codexCatalogAdmitsModel(catalog, 'page-two-private')).toBe(true)
    expect(catalog.models.map((model) => model.id)).toEqual(['listed-default', 'page-two-private'])
    expect(request).toHaveBeenNthCalledWith(
      2,
      'model/list',
      { limit: 100, includeHidden: false, cursor: 'page-2' },
      { timeoutMs: 321 }
    )
  })

  it('hydrates current values from thread start or resume', () => {
    expect(
      reportedCodexThreadOptions(
        {
          threadId: 'thread-1',
          historyPath: null,
          model: 'gpt-live',
          effort: 'high'
        },
        null
      )
    ).toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('admits only provider-listed models when enumeration is nonempty', () => {
    const catalog = {
      models: [{ id: 'account-private', label: 'Private', isDefault: true, efforts: [] }]
    }

    expect(codexCatalogAdmitsModel(catalog, 'account-private')).toBe(true)
    expect(codexCatalogAdmitsModel(catalog, 'gpt-5.6-sol')).toBe(false)
  })

  it.each([null, undefined, { models: [] }])(
    'admits every model without catalog evidence %#',
    (catalog) => {
      expect(codexCatalogAdmitsModel(catalog, 'arbitrary-private-model')).toBe(true)
    }
  )

  it('drops a refused restored model and its effort but retains recognized options', () => {
    const persisted = {
      model: 'retired-id',
      effort: 'high',
      approvalPolicy: 'never',
      personality: 'friendly',
      threadId: 'thread-injected',
      input: 'input-injected'
    }

    expect(
      Object.fromEntries(
        restoredCodexSessionOptions(persisted, {
          models: [{ id: 'listed-default', label: 'Default', isDefault: true, efforts: [] }]
        })
      )
    ).toEqual({ approvalPolicy: 'never', personality: 'friendly' })
    expect(persisted).toEqual({
      model: 'retired-id',
      effort: 'high',
      approvalPolicy: 'never',
      personality: 'friendly',
      threadId: 'thread-injected',
      input: 'input-injected'
    })
  })

  it('filters a refused thread report without claiming a replacement was reported', () => {
    expect(
      reportedCodexThreadOptions(
        { threadId: 'thread-1', historyPath: null, model: 'retired-id', effort: 'high' },
        {
          models: [{ id: 'listed-default', label: 'Default', isDefault: true, efforts: [] }]
        }
      )
    ).toEqual({})
  })

  it('preserves listed and unavailable-evidence restore and report values', () => {
    const opened = {
      threadId: 'thread-1',
      historyPath: null,
      model: 'account-private',
      effort: 'high'
    }
    const persisted = { model: 'account-private', effort: 'high' }
    const catalog = {
      models: [{ id: 'account-private', label: 'Private', isDefault: true, efforts: [] }]
    }

    expect(Object.fromEntries(restoredCodexSessionOptions(persisted, catalog))).toEqual(persisted)
    expect(reportedCodexThreadOptions(opened, catalog)).toEqual(persisted)
    expect(Object.fromEntries(restoredCodexSessionOptions(persisted, null))).toEqual(persisted)
    expect(reportedCodexThreadOptions(opened, null)).toEqual(persisted)
  })

  it('does not expose an incomplete bounded enumeration as an authoritative list', async () => {
    const request = vi.fn(async () => ({ data: [], nextCursor: 'more' }))

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'retired-id' },
        timeoutMs: 321
      })
    ).rejects.toThrow('model enumeration exceeded 20 pages')
    expect(request).toHaveBeenCalledTimes(20)
    expect(request).toHaveBeenLastCalledWith(
      'model/list',
      { limit: 100, includeHidden: false, cursor: 'more' },
      { timeoutMs: 321 }
    )
  })

  it('reconciles an incompatible effort when only the model changes', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          },
          {
            model: 'gpt-fast',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            defaultReasoningEffort: 'low'
          }
        ],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-fast', undefined)
    ).resolves.toEqual({ model: 'gpt-fast', effort: 'low' })
  })

  it('rejects values absent from the provider catalog', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [{ model: 'gpt-live', supportedReasoningEfforts: [] }],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'not-entitled', undefined)
    ).rejects.toThrow('does not offer model not-entitled')
    await expect(
      applyCodexStructuredSessionOption(session, 'effort', 'high', undefined)
    ).rejects.toThrow('does not support high')
  })

  it.each(['options', 'reportedOptions'] as const)(
    'rejects reapplying an unlisted model already seeded in %s',
    async (source) => {
      const session = optionSession(
        vi.fn(async () => ({
          data: [{ model: 'listed-default', supportedReasoningEfforts: [] }],
          nextCursor: null
        }))
      )
      if (source === 'options') {
        session.options.set('model', 'retired-id')
      } else {
        session.reportedOptions = { model: 'retired-id', effort: 'high' }
      }
      const before = {
        options: Object.fromEntries(session.options),
        reportedOptions: { ...session.reportedOptions }
      }

      await expect(
        applyCodexStructuredSessionOption(session, 'model', 'retired-id', undefined)
      ).rejects.toMatchObject({ name: 'AgentSessionOptionRejectedError' })
      expect({
        options: Object.fromEntries(session.options),
        reportedOptions: session.reportedOptions
      }).toEqual(before)
    }
  )

  it('allows reapplying a listed current model', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [
          {
            model: 'gpt-live',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          }
        ],
        nextCursor: null
      }))
    )

    await expect(
      applyCodexStructuredSessionOption(session, 'model', 'gpt-live', undefined)
    ).resolves.toEqual({ model: 'gpt-live', effort: 'high' })
  })

  it('keeps explicit model writes strict when the catalog is empty or unavailable', async () => {
    const empty = optionSession(vi.fn(async () => ({ data: [], nextCursor: null })))
    empty.options.set('model', 'gpt-live')
    await expect(
      applyCodexStructuredSessionOption(empty, 'model', 'gpt-live', undefined)
    ).rejects.toThrow('does not offer model gpt-live')

    const unavailable = optionSession(
      vi.fn(async () => {
        throw new Error('model/list unavailable')
      })
    )
    await expect(
      applyCodexStructuredSessionOption(unavailable, 'model', 'gpt-live', undefined)
    ).rejects.toThrow('model/list unavailable')
  })
})
