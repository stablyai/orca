import { describe, expect, it } from 'vitest'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import { unhandledProviderFrameJournalItem } from './unhandled-provider-frame'

const CODEX_KIND = 'notification:hook/completed'
const CLAUDE_KIND = 'message:system:hook_response'

// Shape captured from codex-cli 0.162.0 with a SessionStart command that exits 1.
const CODEX_FAILURE = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  run: {
    id: 'session-start:0:hooks.json',
    eventName: 'sessionStart',
    handlerType: 'command',
    executionMode: 'sync',
    scope: 'thread',
    sourcePath: 'hooks.json',
    source: 'user',
    status: 'failed',
    entries: [{ kind: 'error', text: 'hook exited with code 1' }]
  }
}

describe('failed hook provider frames', () => {
  it('projects the Codex hook name and nested failure with its original Details', () => {
    const row = unhandledProviderFrameJournalItem('codex', CODEX_KIND, CODEX_FAILURE)
    expect(row).toMatchObject({
      classification: 'error-surface',
      body: {
        kind: 'status',
        tone: 'error',
        text: 'Codex SessionStart hook failed: hook exited with code 1'
      }
    })
    expect(row?.body.providerFrame?.payload.head).toBe(JSON.stringify(CODEX_FAILURE))
    expect(row?.body.providerFrame?.payload.truncated).toBe(false)
    if (!row) {
      throw new Error('Expected failed hook row')
    }
    expect(
      projectStructuredItemToNativeChat({
        itemId: 'failed-hook',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: row.body
      })
    ).toMatchObject({
      role: 'system',
      blocks: [
        { type: 'text', tone: 'error', text: row.body.text, providerFrame: row.body.providerFrame }
      ]
    })
  })

  it('preserves multiple error entries without displaying hook progress as the error', () => {
    const payload = {
      run: {
        eventName: 'preToolUse',
        status: 'failed',
        statusMessage: 'Running hook',
        entries: [
          { kind: 'info', text: 'Running hook' },
          { kind: 'error', text: ' First failure ' },
          null,
          { kind: 'error', text: 1 },
          { kind: 'error', text: 'Second failure' }
        ]
      }
    }
    expect(unhandledProviderFrameJournalItem('codex', CODEX_KIND, payload)?.body.text).toBe(
      'Codex PreToolUse hook failed: First failure\nSecond failure'
    )
  })

  it.each([undefined, null, 'invalid', [null], [{ kind: 'error', text: ' ' }]])(
    'keeps a named error visible when Codex entries are missing or malformed: %j',
    (entries) => {
      expect(
        unhandledProviderFrameJournalItem('codex', CODEX_KIND, {
          run: { eventName: 'stop', status: 'failed', entries }
        })?.body
      ).toMatchObject({ text: 'Codex Stop hook failed.', tone: 'error' })
    }
  )

  it('uses a readable fallback when a failed hook carries no name', () => {
    expect(
      unhandledProviderFrameJournalItem('codex', CODEX_KIND, {
        run: { status: 'failed', entries: [{ kind: 'error', text: 'Timed out' }] }
      })?.body.text
    ).toBe('Codex hook failed: Timed out')
    expect(
      unhandledProviderFrameJournalItem('codex', CODEX_KIND, {
        run: { status: 'failed' },
        message: 'Hook could not start'
      })?.body.text
    ).toBe('Codex hook failed: Hook could not start')
    expect(
      unhandledProviderFrameJournalItem('claude', CLAUDE_KIND, {
        outcome: 'error'
      })?.body.text
    ).toBe('Claude hook failed.')
  })

  it('shows Claude stderr and the exit code instead of the wire event name', () => {
    expect(
      unhandledProviderFrameJournalItem('claude', CLAUDE_KIND, {
        hook_name: 'PostToolUse:Bash',
        hook_event: 'PostToolUse',
        outcome: 'error',
        exit_code: 1,
        stderr: ' Script not found\n',
        output: 'Other output'
      })?.body
    ).toMatchObject({
      tone: 'error',
      text: 'Claude PostToolUse:Bash hook failed (exit code 1): Script not found'
    })
  })

  it.each([
    {
      stderr: ' ',
      output: 'Hook output',
      stdout: 'Other stdout',
      exit_code: null,
      expected: 'Hook output'
    },
    { stderr: null, output: ' ', stdout: 'Hook stdout', exit_code: '1', expected: 'Hook stdout' },
    {
      stderr: {},
      output: null,
      message: 'Hook could not start',
      exit_code: 0,
      expected: 'Hook could not start'
    }
  ])('uses available Claude output when stderr is empty: $expected', ({ expected, ...fields }) => {
    expect(
      unhandledProviderFrameJournalItem('claude', CLAUDE_KIND, {
        hook_event: 'SessionStart',
        outcome: 'error',
        ...fields
      })?.body.text
    ).toBe(`Claude SessionStart hook failed: ${expected}`)
  })

  it('retains a Claude exit code when there is no output', () => {
    expect(
      unhandledProviderFrameJournalItem('claude', CLAUDE_KIND, {
        hook_name: 'SessionStart:startup',
        outcome: 'error',
        exit_code: 1
      })?.body.text
    ).toBe('Claude SessionStart:startup hook failed (exit code 1).')
  })

  it('keeps successful hooks hidden even when they produce diagnostic output', () => {
    expect(
      unhandledProviderFrameJournalItem('codex', CODEX_KIND, {
        run: { status: 'completed', entries: [{ kind: 'info', text: 'Hook completed' }] }
      })
    ).toBeNull()
    expect(
      unhandledProviderFrameJournalItem('claude', CLAUDE_KIND, {
        hook_name: 'SessionStart',
        outcome: 'success',
        exit_code: 0,
        stderr: 'Diagnostic output'
      })
    ).toBeNull()
  })

  it('keeps long hook error text whole and bounds only the raw Details', () => {
    const row = unhandledProviderFrameJournalItem(
      'codex',
      CODEX_KIND,
      {
        run: { status: 'failed', entries: [{ kind: 'error', text: 'x'.repeat(1000) }] }
      },
      { inlineHeadBytes: 64 }
    )
    expect(row?.body.text).toBe(`Codex hook failed: ${'x'.repeat(1000)}`)
    expect(row?.body.providerFrame?.payload).toMatchObject({ truncated: true })
    expect(
      Buffer.byteLength(row?.body.providerFrame?.payload.head ?? '', 'utf8')
    ).toBeLessThanOrEqual(64)
  })

  it('leaves other providers and unrelated frame kinds on their existing fallback', () => {
    const payload = { outcome: 'error', hook_name: 'Other hook', stderr: 'Failure' }
    expect(
      unhandledProviderFrameJournalItem('future-provider', CLAUDE_KIND, payload)?.body.text
    ).toBe(`future-provider · ${CLAUDE_KIND}`)
    expect(
      unhandledProviderFrameJournalItem('claude', 'message:future/event', payload)?.body.text
    ).toBe('claude · message:future/event')
  })
})
