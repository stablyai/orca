import { describe, expect, it } from 'vitest'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'
import { UNRETAINED_JOURNAL_PAYLOAD_LIMITS } from '../agent-session-journal/journal-payload-bounds'

describe('unhandled provider frame journal fallback', () => {
  it('keeps a compact label and bounds the expandable payload without dropping it', () => {
    const item = unhandledProviderFrameJournalItem(
      'future-provider',
      'notification:new/event',
      { body: 'abcdefghij' },
      { ...UNRETAINED_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8 }
    )

    expect(item).not.toBeNull()
    if (!item) {
      throw new Error('expected substantive provider frame')
    }
    expect(item.body).toMatchObject({
      kind: 'status',
      text: 'future-provider · notification:new/event',
      providerFrame: {
        provider: 'future-provider',
        kind: 'notification:new/event',
        payload: { byteLength: 21, truncated: true }
      }
    })
    expect(
      Buffer.byteLength(item.body.providerFrame?.payload.head ?? '', 'utf8')
    ).toBeLessThanOrEqual(8)
  })

  it('turns an unserializable message-shaped payload into an explicit visible value', () => {
    const cyclic: { warning?: unknown } = {}
    cyclic.warning = cyclic

    const item = unhandledProviderFrameJournalItem(
      'codex',
      'frame',
      cyclic,
      UNRETAINED_JOURNAL_PAYLOAD_LIMITS
    )

    expect(item?.body.text).toBe('codex · frame')
    expect(item?.body.providerFrame?.payload.head).toContain('unserializable payload')
  })

  it('routes provider lifecycle, startup, and status frames away from the timeline', () => {
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:thread/started',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:mcpServer/startupStatus/updated',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:remoteControl/status/changed',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:thread/tokenUsage/updated',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:thread/goal/cleared',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'claude',
        'message:system:init',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'claude',
        'message:result',
        {
          subtype: 'success',
          is_error: false
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
  })

  it('never creates generic rows for delta-shaped frames that report no failure', () => {
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:item/commandExecution/outputDelta',
        {
          itemId: 'exec-1',
          delta: 'x'
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:item/future/outputDelta',
        {
          itemId: 'future-1',
          delta: 'y'
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
  })

  it('surfaces an unknown delta-shaped frame whose payload reports an error', () => {
    const row = unhandledProviderFrameJournalItem(
      'codex',
      'notification:item/future/outputDelta',
      {
        error: 'stream broke mid-item'
      },
      UNRETAINED_JOURNAL_PAYLOAD_LIMITS
    )

    expect(row).not.toBeNull()
    expect(row?.classification).toBe('error-surface')
    expect(row?.body.providerFrame).toMatchObject({
      provider: 'codex',
      kind: 'notification:item/future/outputDelta'
    })
  })

  it('renders codex systemError and Claude error result variants', () => {
    const codex = unhandledProviderFrameJournalItem(
      'codex',
      'notification:thread/status/changed',
      {
        threadId: 'thread-1',
        status: { type: 'systemError' }
      },
      UNRETAINED_JOURNAL_PAYLOAD_LIMITS
    )
    const claude = unhandledProviderFrameJournalItem(
      'claude',
      'message:result',
      {
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Provider request failed'
      },
      UNRETAINED_JOURNAL_PAYLOAD_LIMITS
    )

    expect(codex?.body.providerFrame).toMatchObject({
      provider: 'codex',
      kind: 'notification:thread/status/changed'
    })
    expect(claude?.body.providerFrame).toMatchObject({
      provider: 'claude',
      kind: 'message:result'
    })
    expect(
      claude
        ? projectStructuredItemToNativeChat({
            itemId: 'claude-error',
            revision: 1,
            sequence: 1,
            observedAt: 1,
            body: claude.body
          })
        : null
    ).toMatchObject({
      role: 'system',
      blocks: [
        expect.objectContaining({
          providerFrame: expect.objectContaining({ kind: 'message:result' })
        })
      ]
    })
  })

  it('keeps failed startup variants visible while suppressing startup progress', () => {
    const kind = 'notification:mcpServer/startupStatus/updated'

    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        kind,
        {
          name: 'filesystem',
          status: 'starting',
          error: null,
          failureReason: null
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        kind,
        {
          name: 'filesystem',
          status: 'failed',
          error: 'server exited',
          failureReason: null
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).not.toBeNull()
  })

  it('surfaces a failed hook completion while suppressing successful hook lifecycle', () => {
    const kind = 'notification:hook/completed'

    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        kind,
        {
          run: { id: 'hook-1', status: 'completed' }
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        kind,
        {
          run: { id: 'hook-1', status: 'failed' }
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).not.toBeNull()
  })

  it('keeps unknown substantive frames visible for both providers', () => {
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:future/event',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).not.toBeNull()
    expect(
      unhandledProviderFrameJournalItem(
        'claude',
        'message:future/event',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).not.toBeNull()
  })

  it('leads with the provider sentence instead of naming the opcode', () => {
    const row = unhandledProviderFrameJournalItem(
      'codex',
      'notification:warning',
      {
        message: 'Your plan limit resets in 2 hours.'
      },
      UNRETAINED_JOURNAL_PAYLOAD_LIMITS
    )
    expect(row?.body.text).toBe('Your plan limit resets in 2 hours.')
    // The raw frame stays available behind the row's disclosure.
    expect(row?.body.providerFrame?.kind).toBe('notification:warning')
  })

  it('bounds a provider sentence inline', () => {
    const message = 'abcdefghij'
    const row = unhandledProviderFrameJournalItem(
      'codex',
      'notification:warning',
      { message },
      { ...UNRETAINED_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8 }
    )

    expect(row?.body.text).toContain('abcdefgh')
    expect(row?.body.text).toContain('[Orca: output truncated')
  })

  it('unwraps a nested sentence and falls back to the opcode when there is none', () => {
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:warning',
        {
          warning: { text: 'Sandbox is degraded.' }
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )?.body.text
    ).toBe('Sandbox is degraded.')
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:future/event',
        { count: 3 },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )?.body.text
    ).toBe('codex \u00b7 notification:future/event')
  })
})

describe('a failed provider dependency', () => {
  it('leads with the failure the provider reported, not the method name', () => {
    const item = unhandledProviderFrameJournalItem(
      'codex',
      'notification:mcpServer/startupStatus/updated',
      {
        threadId: 'thread-1',
        name: 'codex_apps',
        status: 'failed',
        error: 'MCP client for `codex_apps` failed to start: authentication token invalidated',
        failureReason: 'reauthenticationRequired'
      },
      UNRETAINED_JOURNAL_PAYLOAD_LIMITS
    )
    expect(item?.classification).toBe('error-surface')
    expect(item?.body.text).toContain('failed to start')
    expect(item?.body.text).not.toContain('notification:mcpServer')
  })

  it('stays out of the timeline while the dependency is merely starting', () => {
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:mcpServer/startupStatus/updated',
        {
          threadId: 'thread-1',
          name: 'codex_apps',
          status: 'starting'
        },
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toBeNull()
  })
})

describe('typed notice metadata', () => {
  it('publishes readable compaction statuses for both provider forms', () => {
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'notification:thread/compacted',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toMatchObject({
      classification: 'timeline-substantive',
      body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    })
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        'item:contextCompaction',
        {},
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toMatchObject({
      body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    })
  })
  it.each([
    ['warning', { message: 'Check this' }, 'warning', 'Check this'],
    ['guardianWarning', { message: 'Review required' }, 'warning', 'Review required'],
    [
      'configWarning',
      { summary: 'Invalid option', details: 'Remove the option' },
      'warning',
      'Invalid option\n\nRemove the option'
    ],
    [
      'deprecationNotice',
      { summary: 'Old option', details: 'Use its replacement' },
      'notice',
      'Old option\n\nUse its replacement'
    ],
    ['error', { error: { message: 'Connection failed' } }, 'error', 'Connection failed']
  ])('assigns the tone and readable text for %s', (method, payload, tone, text) => {
    expect(
      unhandledProviderFrameJournalItem(
        'codex',
        `notification:${method}`,
        payload,
        UNRETAINED_JOURNAL_PAYLOAD_LIMITS
      )
    ).toMatchObject({
      classification: 'error-surface',
      body: { kind: 'status', text, tone }
    })
  })
})
