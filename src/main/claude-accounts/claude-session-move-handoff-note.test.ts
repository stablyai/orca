import { describe, expect, it, vi } from 'vitest'
import {
  buildClaudeSessionMoveHandoffNote,
  captureClaudeSessionMoveEndedWork,
  claudeResumeHookBaseline,
  claudeResumeHooksReady,
  claudeResumeScreenAcceptsHandoff,
  claudeResumeScreenIsShellPrompt,
  detachedJobsForSession,
  type ClaudeSessionMoveHandoffTranslate
} from './claude-session-move-handoff-note'

const PASSTHROUGH: ClaudeSessionMoveHandoffTranslate = (_key, fallback) => fallback

describe('buildClaudeSessionMoveHandoffNote', () => {
  it('names the accounts, the reason, and the work the restart ended', () => {
    const note = buildClaudeSessionMoveHandoffNote(
      {
        fromEmail: 'from@example.com',
        toEmail: 'to@example.com',
        detail: 'session 96%',
        endedWork: captureClaudeSessionMoveEndedWork({
          workingMode: 'monitoring',
          claudeRunningNonAgentTask: true,
          subagents: [
            { id: 'idle-1', state: 'idle' },
            { id: 'child-1', agentType: 'explore', state: 'working' }
          ]
        })
      },
      PASSTHROUGH
    )
    expect(note).toBe(
      [
        'Orca moved this session from from@example.com to to@example.com because session 96%.',
        'The restart ended subagents of the previous process',
        '(monitoring; a background task was still running; explore child-1 (working); idle-1 (idle)).',
        'No detached Orca jobs were still running.',
        'Re-run what is still needed, then continue.'
      ].join(' ')
    )
  })

  it('fills placeholders when translate returns the fallback unchanged', () => {
    const translate = vi.fn(PASSTHROUGH)
    const note = buildClaudeSessionMoveHandoffNote(
      {
        fromEmail: 'from@example.com',
        toEmail: 'to@example.com',
        detail: '   ',
        endedWork: captureClaudeSessionMoveEndedWork({
          subagents: [
            { id: '', state: 'working' },
            { id: 'bare', state: 'waiting' }
          ]
        })
      },
      translate
    )
    expect(note).toContain('because its usage limit.')
    expect(note).toContain('(bare (waiting)).')
    expect(note).not.toContain('{{')
    expect(note).not.toContain('a background task')
    expect(note).not.toContain('monitoring')
    expect(translate).toHaveBeenCalledWith(
      'accounts.claude.sessionMover.handoff.moved',
      'Orca moved this session from {{from}} to {{to}} because {{detail}}.',
      { from: 'from@example.com', to: 'to@example.com', detail: 'its usage limit' }
    )
  })

  it('fills braces a translator leaves behind and caps the subagent list', () => {
    const translate: ClaudeSessionMoveHandoffTranslate = (key, fallback) =>
      key.endsWith('.moved') ? 'from {{from}} to {{to}}' : fallback
    const subagents = Array.from({ length: 13 }, (_, index) => ({
      id: `child-${index}`,
      agentType: 'explore',
      state: 'working' as const
    }))
    const note = buildClaudeSessionMoveHandoffNote(
      {
        fromEmail: 'from@example.com',
        toEmail: 'to@example.com',
        detail: 'session 96%',
        endedWork: { subagents }
      },
      translate
    )
    expect(note.startsWith('from from@example.com to to@example.com ')).toBe(true)
    expect(note).toContain('explore child-11 (working)')
    expect(note).not.toContain('child-12')
    expect(note).toContain('and 1 more')
  })

  it('says none reported when the pre-move row listed no work', () => {
    const note = buildClaudeSessionMoveHandoffNote(
      {
        fromEmail: 'from@example.com',
        toEmail: 'to@example.com',
        detail: 'session 96%',
        endedWork: { claudeRunningNonAgentTask: false, subagents: [] }
      },
      PASSTHROUGH
    )
    expect(note).toContain('(none reported).')
    expect(note).toContain('No detached Orca jobs were still running.')
  })

  it('names running jobs passed in and skips exited ones', () => {
    const note = buildClaudeSessionMoveHandoffNote(
      {
        fromEmail: 'from@example.com',
        toEmail: 'to@example.com',
        detail: 'session 96%',
        endedWork: { subagents: [] },
        detachedJobs: [
          {
            state: 'running',
            id: 'dj_0123456789abcdef',
            logPath: '/tmp/job/output.log',
            sessionId: 'sess-1'
          },
          {
            state: 'exited',
            id: 'dj_abcdef0123456789',
            logPath: '/tmp/other/output.log',
            sessionId: 'sess-1'
          }
        ]
      },
      PASSTHROUGH
    )
    expect(note).toContain(
      'Detached Orca jobs still running after this restart: dj_0123456789abcdef log=/tmp/job/output.log.'
    )
    expect(note).toContain('The restart ended subagents of the previous process (none reported).')
    expect(note.match(/dj_[a-f0-9]{16}/g)).toEqual(['dj_0123456789abcdef'])
  })

  it('keeps every job whose request names this session', () => {
    expect(
      detachedJobsForSession('sess-1', [
        { state: 'running', id: 'dj_0123456789abcdef', logPath: '/a', sessionId: 'sess-1' },
        { state: 'running', id: 'dj_abcdef0123456789', logPath: '/b', sessionId: 'sess-2' },
        { state: 'exited', id: 'dj_0000000000000001', logPath: '/c', sessionId: 'sess-1' }
      ]).map((job) => job.id)
    ).toEqual(['dj_0123456789abcdef', 'dj_0000000000000001'])
  })
})

describe('claude resume handoff readiness', () => {
  const paneKey = 'pane-1'
  const sessionId = 'sess-1'
  const row = {
    state: 'done',
    receivedAt: 10,
    providerSession: { id: sessionId }
  }

  it('treats a shell prompt as closed, including one drawn after the composer', () => {
    expect(claudeResumeScreenIsShellPrompt('user@host:~$ ')).toBe(true)
    expect(claudeResumeScreenIsShellPrompt('ready %')).toBe(true)
    expect(claudeResumeScreenIsShellPrompt('session 96%')).toBe(false)
    expect(claudeResumeScreenIsShellPrompt('\u001b]133;A\u0007')).toBe(true)
    expect(claudeResumeScreenAcceptsHandoff('\u001b[?2031h❯\u00a0\r\n$ ')).toBe(false)
    expect(claudeResumeScreenAcceptsHandoff('\u001b[?2004h~/repo \u001b[32m❯\u00a0\u001b[0m')).toBe(
      false
    )
  })

  it('accepts only Claude composer bytes on the timeout path', () => {
    expect(claudeResumeScreenAcceptsHandoff('\u001b[?2031h❯\u00a0')).toBe(true)
    expect(claudeResumeScreenAcceptsHandoff('still starting')).toBe(false)
    expect(claudeResumeScreenAcceptsHandoff('')).toBe(false)
    expect(claudeResumeScreenAcceptsHandoff('$ ')).toBe(false)
  })

  it('requires a done row newer than the pre-spawn baseline for the same session', () => {
    const identities = [{ paneKey, sessionId }]
    const args = {
      rows: [row],
      identities,
      paneKey,
      sessionId,
      baselineReceivedAt: claudeResumeHookBaseline([row])
    }
    expect(claudeResumeHooksReady(args)).toBe(false)
    expect(
      claudeResumeHooksReady({
        ...args,
        rows: [{ ...row, receivedAt: 11, providerSessionOnly: true }]
      })
    ).toBe(false)
    expect(
      claudeResumeHooksReady({
        ...args,
        rows: [{ ...row, receivedAt: 11, state: 'working' }]
      })
    ).toBe(false)
    expect(claudeResumeHooksReady({ ...args, identities: [] })).toBe(false)
    expect(
      claudeResumeHooksReady({
        ...args,
        rows: [{ ...row, receivedAt: 11 }]
      })
    ).toBe(true)
  })
})
