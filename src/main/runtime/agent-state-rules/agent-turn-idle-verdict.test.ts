import { describe, expect, it } from 'vitest'
import { AGENT_START_GRACE_MS, judgeIdleAgentTurn } from './agent-turn-idle-verdict'

const SENT_AT = 1_000_000

function judgeStatusFreePane(tail: string[]): ReturnType<typeof judgeIdleAgentTurn> {
  return judgeIdleAgentTurn(
    { rows: [], sentAt: SENT_AT, tail, readAgentCommands: () => ['claude'] },
    SENT_AT + AGENT_START_GRACE_MS
  )
}

describe('an idle pane whose agent never reported status', () => {
  it.each([
    // oh-my-zsh's update prompt read the "." of ". '<script>'", so zsh ran the 0600 script.
    'zsh: permission denied: /var/folders/_f/x/T/orca-launch-ee233a6e5ee6de6a.sh',
    'zsh: permission denied: /Users/me/tmp dir/orca-launch-ee233a6e5ee6de6a.sh',
    'bash: line 1: /tmp/orca-launch-0123456789abcdef.sh: Permission denied',
    'dash: 1: /tmp/orca-launch-0123456789abcdef.sh: Permission denied'
  ])('fails when the shell refused the staged launch script: %s', (refusal) => {
    expect(
      judgeStatusFreePane([
        "[oh-my-zsh] Would you like to update? [Y/n] . '/tmp/orca-launch-0123456789abcdef.sh'",
        refusal,
        '➜  repo git:(main)'
      ])
    ).toEqual({ kind: 'failed', missingCommandLine: refusal })
  })

  it('still completes when a command inside the sourced launch script failed', () => {
    expect(
      judgeStatusFreePane([
        '/tmp/orca-launch-0123abcd.sh: line 2: cd: /gone: No such file or directory',
        '/tmp/orca-launch-0123abcd.sh:cd:2: no such file or directory: /gone',
        'cat: /Users/me/.claude/settings.json: Permission denied',
        '$'
      ])
    ).toEqual({ kind: 'completed', interrupted: false })
  })
})
