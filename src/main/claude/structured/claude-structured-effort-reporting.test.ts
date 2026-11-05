import { describe, expect, it } from 'vitest'
import {
  readClaudeSettingsEffort,
  readClaudeSettingsApplied
} from './launch/claude-structured-session-options'
import { ClaudeControlRequestTimeoutError } from '../claude-agent-sdk-control-requests'
import recordedUltracodeSettings from '../__fixtures__/ultracode-settings.json'
import {
  USER_MESSAGE,
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor,
  recordingJournalSink
} from './claude-structured-session-test-support'

describe('Claude effort reporting', () => {
  it('distinguishes old CLI omissions from native no-effort and malformed responses', () => {
    expect(readClaudeSettingsEffort({ effective: { effortLevel: 'high' } })).toBe('high')
    expect(readClaudeSettingsEffort({ applied: {}, effective: { effortLevel: 'high' } })).toBe(
      'high'
    )
    expect(
      readClaudeSettingsEffort({ applied: { effort: null }, effective: { effortLevel: 'high' } })
    ).toBeNull()
    expect(
      readClaudeSettingsEffort({ applied: { effort: 42 }, effective: { effortLevel: 'high' } })
    ).toBeUndefined()
    expect(
      readClaudeSettingsEffort({ applied: null, effective: { effortLevel: 'high' } })
    ).toBeUndefined()
    expect(readClaudeSettingsApplied(recordedUltracodeSettings.configured)?.effort).toBe('xhigh')
    expect(readClaudeSettingsEffort(recordedUltracodeSettings.configured)).toBe('ultracode')
  })

  it('keeps a configured workflow at launch without confirming saved ordinary XHigh', async () => {
    const claude = fakeClaude({
      settings: { applied: { effort: 'xhigh', ultracode: true }, effective: {} }
    })
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'configured-workflow',
      options: { effort: 'xhigh' },
      events: recordingJournalSink()
    })
    const current = (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
    expect(current.effort).toBe('xhigh')
    expect(current.confirmed ?? []).not.toContain('effort')
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'configured-workflow',
        body: USER_MESSAGE,
        executionOptions: { effort: 'xhigh' },
        fence: 7
      })
    ).resolves.toMatchObject({ state: 'admitted', ranOptions: { effort: 'ultracode' } })
    expect(claude.connections[0]!.calls.map(({ subtype }) => subtype)).not.toContain(
      'apply_flag_settings'
    )
    const connection = claude.connections[0]!
    connection.getSettings = async () => recordedUltracodeSettings.configured
    claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    for (const clientMessageId of ['fast-on', 'after-fast']) {
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId,
          body: USER_MESSAGE,
          executionOptions: { effort: 'xhigh', fastMode: 'true' },
          fence: 7
        })
      ).resolves.toMatchObject({ state: 'admitted' })
      claudeFrame(connection, { type: 'system', subtype: 'session_state_changed', state: 'idle' })
    }
    expect(
      connection.calls
        .filter(({ subtype }) => subtype === 'apply_flag_settings')
        .map(({ params }) => params?.settings)
    ).toEqual([{ fastMode: true }, { effortLevel: 'xhigh' }])
    await adapter.closeAll()
  })

  it('leaves an attempted workflow after lost enable and exit acknowledgements', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'uncertain-workflow',
      options: { effort: 'xhigh' },
      events: recordingJournalSink()
    })
    const connection = claude.connections[0]!
    connection.getSettings = async () => null
    const settings: unknown[] = []
    connection.applyFlagSettings = async (input) => {
      settings.push(input)
      if (settings.length < 3) {
        throw new ClaudeControlRequestTimeoutError('apply_flag_settings')
      }
    }
    for (const [clientMessageId, effort, state] of [
      ['enable', 'ultracode', 'rejected'],
      ['exit-unanswered', 'xhigh', 'rejected'],
      ['exit-retry', 'xhigh', 'admitted']
    ] as const) {
      await expect(
        adapter.dispatch({
          sessionId: 'session-1',
          clientMessageId,
          body: USER_MESSAGE,
          executionOptions: { effort },
          fence: 7
        })
      ).resolves.toMatchObject({ state })
    }
    expect(settings).toEqual([
      { effortLevel: 'xhigh', ultracode: true },
      { effortLevel: 'xhigh', ultracode: false },
      { effortLevel: 'xhigh', ultracode: false }
    ])
    expect(connection.sent).toHaveLength(1)
    await adapter.closeAll()
  })
})
