import { describe, expect, it, vi } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import {
  applyCodexStructuredSessionOption,
  readCodexStructuredSessionOptions,
  readLiveCodexSessionOptions,
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
        restoredCodexSessionOptions({
          model: 'gpt-live',
          effort: 'high',
          threadId: 'thread-injected',
          input: 'input-injected'
        })
      )
    ).toEqual({ model: 'gpt-live', effort: 'high' })
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

  it('reports an unlisted current model without offering it as a choice', async () => {
    // Was: a fabricated `{ id, label: id, efforts: [] }` row, which offered a raw launch
    // id in the picker as though the account were entitled to it.
    const request = vi.fn(async () => ({
      data: [{ model: 'gpt-live', displayName: 'GPT Live', isDefault: true }],
      nextCursor: null
    }))

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: { model: 'gpt-unlisted' }
      })
    ).resolves.toEqual({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-unlisted' }
    })
  })

  it('confirms a model the thread reported, but not a pick we restored', async () => {
    // The display rule names an unlisted model only when the agent reported it, so the
    // reader has to say which of the two answered. `session.options` is a restored pick
    // or an unechoed write of ours; `reportedOptions` is the opened thread's own state.
    const request = vi.fn(async () => ({
      data: [{ model: 'gpt-live', displayName: 'GPT Live', isDefault: true }],
      nextCursor: null
    }))
    const session = (
      options: Map<string, string>,
      reported: Record<string, string>
    ): CodexSession =>
      ({ connection: { request }, options, reportedOptions: reported }) as unknown as CodexSession

    await expect(
      readLiveCodexSessionOptions(session(new Map(), { model: 'gpt-unlisted' }), undefined)
    ).resolves.toMatchObject({ current: { model: 'gpt-unlisted', confirmed: ['model'] } })

    const restored = await readLiveCodexSessionOptions(
      session(new Map([['model', 'gpt-stale']]), {}),
      undefined
    )
    expect(restored.current).toEqual({ model: 'gpt-stale' })
    expect(restored.current.confirmed).toBeUndefined()

    const changedModel = await readLiveCodexSessionOptions(
      session(new Map([['model', 'gpt-stale']]), { model: 'gpt-old', effort: 'high' }),
      undefined
    )
    expect(changedModel.current).toEqual({ model: 'gpt-stale', effort: 'high' })
    expect(changedModel.current.confirmed).toBeUndefined()
  })

  it('confirms a restored model when the opened thread reported the same value', async () => {
    const request = vi.fn(async () => ({
      data: [{ model: 'gpt-live', displayName: 'GPT Live', isDefault: true }],
      nextCursor: null
    }))
    const restored = {
      connection: { request },
      options: new Map([['model', 'gpt-unlisted']]),
      reportedOptions: { model: 'gpt-unlisted' }
    } as unknown as CodexSession

    const result = await readLiveCodexSessionOptions(restored, undefined)
    expect(result).toMatchObject({
      current: { model: 'gpt-unlisted', confirmed: ['model'] }
    })
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      result
    )
    const model = structuredAgentSessionOptionSnapshot(state)[0]!
    expect(model).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'gpt-unlisted' }
    })
    expect(model.kind.type === 'select' ? model.kind.choices : []).not.toContainEqual(
      expect.objectContaining({ value: 'gpt-unlisted' })
    )
  })

  it('does not confirm a model it substituted rather than read', async () => {
    // With nothing current the reader picks the default; that is our choice, not a report.
    const request = vi.fn(async () => ({
      data: [{ model: 'gpt-live', displayName: 'GPT Live', isDefault: true }],
      nextCursor: null
    }))

    await expect(
      readCodexStructuredSessionOptions({
        connection: { request } as never,
        current: {},
        confirmed: ['model']
      })
    ).resolves.toEqual({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-live' }
    })
  })

  it('hydrates current values from thread start or resume', () => {
    expect(
      reportedCodexThreadOptions({
        threadId: 'thread-1',
        historyPath: null,
        model: 'gpt-live',
        effort: 'high'
      })
    ).toEqual({ model: 'gpt-live', effort: 'high' })
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

  it('applies a catalog-safe effort to a running unlisted model', async () => {
    const session = optionSession(
      vi.fn(async () => ({
        data: [{ model: 'gpt-live', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
        nextCursor: null
      }))
    )
    session.reportedOptions = { model: 'gpt-unlisted', effort: 'medium' }
    const result = await readLiveCodexSessionOptions(session, undefined)
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      result
    )
    expect(canSetStructuredAgentSessionOption(state, 'effort', 'high')).toBe(true)

    await expect(
      applyCodexStructuredSessionOption(session, 'effort', 'high', undefined)
    ).resolves.toEqual({ model: 'gpt-unlisted', effort: 'high' })
    expect(session.reportedOptions).toEqual({ model: 'gpt-unlisted' })
    await expect(readLiveCodexSessionOptions(session, undefined)).resolves.toMatchObject({
      current: { model: 'gpt-unlisted', effort: 'high', confirmed: ['model'] }
    })
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
})
