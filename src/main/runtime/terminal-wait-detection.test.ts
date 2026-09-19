import { describe, expect, it } from 'vitest'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

// Why these shapes: Codex agents working on Orca print `rg` hits from this very detector and its
// specs, so quoted prompt wording lands in scrollback while the terminal sits at its input box.
const QUOTED_DETECTOR_SOURCE_LINE =
  "└   if (hooksindex !== -1 && normalized.includes('press enter to confirm', hooksindex)) {"
const QUOTED_PERMISSION_FIXTURE_LINE =
  "  └ 236:      'Permission required\\nThis command requires permission\\nAllow once\\nAllow always\\nReject\\n',"

function codexIdleScreen(): string[] {
  return [
    '• Done. The detector bounding is in place and the suite passes.',
    '',
    '› Ask Codex to do anything',
    '',
    '  gpt-6-astra medium · ~/orca/workspaces/orca/fix-wait-detector-scrollback'
  ]
}

function codexScrollback(quotedLines: string[], trailingLineCount: number): string[] {
  const lines: string[] = [
    '• Explored',
    '  └ Search press enter to confirm in src/main/runtime',
    '    Read terminal-wait-detection.ts',
    '',
    '• Ran rg -n "press enter to confirm" src/main/runtime/terminal-wait-detection.ts src/main/runtime/orca-runtime-tests/agent-status-and-waits.spec.ts',
    '  └ src/main/runtime/terminal-wait-detection.ts',
    '    src/main/runtime/orca-runtime-tests/agent-status-and-waits.spec.ts',
    '    src/main/runtime/orca-runtime-tests/terminal-creation-and-readiness-part-07.spec.ts',
    ...quotedLines
  ]
  for (let index = 0; index < trailingLineCount; index += 1) {
    lines.push(`    ${index}: unrelated codex narration about hook wiring and sandbox policy`)
  }
  return lines
}

function waitTextFor(lines: string[]): string {
  return buildTerminalWaitText(lines, '', '')
}

describe('detectTerminalWaitBlockedReason scrollback bounding', () => {
  it('ignores detector source quoted by rg output far above an idle Codex input box', () => {
    const waitText = waitTextFor([
      ...codexScrollback([QUOTED_DETECTOR_SOURCE_LINE], 300),
      ...codexIdleScreen()
    ])

    expect(waitText).toContain('press enter to confirm')
    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
  })

  it('ignores a quoted permission fixture in scrollback above an idle Codex input box', () => {
    const waitText = waitTextFor([
      ...codexScrollback([QUOTED_PERMISSION_FIXTURE_LINE], 300),
      ...codexIdleScreen()
    ])

    expect(waitText.toLowerCase()).toContain('allow once')
    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
  })

  it('ignores quoted prompt wording just above the live-dialog window', () => {
    // Why 10: with the 3-line idle screen the quoted lines sit 13-14 non-blank lines from the bottom.
    const waitText = waitTextFor([
      ...codexScrollback([QUOTED_DETECTOR_SOURCE_LINE, QUOTED_PERMISSION_FIXTURE_LINE], 10),
      ...codexIdleScreen()
    ])

    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
  })

  it('does not let quoted scrollback wording veto a Codex ready header', () => {
    const waitText = waitTextFor([
      ...codexScrollback([QUOTED_PERMISSION_FIXTURE_LINE], 40),
      ' >_ OpenAI Codex (v0.153.3)',
      ' model:       gpt-6-astra medium   /model to change',
      ' directory:   ~/orca/workspaces/orca/fix-wait-detector-scrollback'
    ])

    expect(isKnownReadyPromptPreview(waitText)).toBe(true)
  })
})

// Real dialog text: terminal-creation-and-readiness-part-07.spec.ts and agent-status-and-waits.spec.ts.
const LIVE_CODEX_PROMPTS: { name: string; lines: string[]; reason: string }[] = [
  {
    name: 'hooks review',
    lines: [
      'Hooks need review',
      '2 hooks are new or changed.',
      '1. Review hooks',
      '2. Trust all and continue',
      'Press enter to confirm or esc to go back'
    ],
    reason: 'agent-hooks-review-prompt'
  },
  {
    name: 'trust workspace',
    lines: ['Do you trust this workspace directory?', '1. Yes', '2. No'],
    reason: 'agent-trust-workspace'
  },
  {
    name: 'update',
    lines: [
      'Update available! 0.131.0 -> 0.132.0',
      '1. Update now',
      '2. Skip',
      'Press enter to continue'
    ],
    reason: 'agent-update-prompt'
  },
  {
    name: 'cwd selection',
    lines: [
      'Choose working directory to resume this session',
      '  Session = latest cwd recorded in the resumed session',
      '  Current = your current working directory',
      '  Press enter to continue'
    ],
    reason: 'agent-cwd-prompt'
  },
  {
    name: 'model migration',
    lines: [
      'Codex just got an upgrade. Introducing gpt-5.1-codex-max.',
      'We recommend switching from gpt-5-codex to gpt-5.1-codex-max.',
      'Press enter to continue'
    ],
    reason: 'codex-model-migration-prompt'
  },
  {
    name: 'grant permissions',
    lines: [
      'Would you like to grant these permissions?',
      '1. Yes, grant these permissions for this turn',
      '2. No, continue without permissions',
      'Press enter to confirm or esc to cancel'
    ],
    reason: 'agent-interactive-prompt'
  },
  {
    name: 'permission required',
    lines: [
      'Permission required',
      'This command requires permission',
      'Allow once',
      'Allow always',
      'Reject'
    ],
    reason: 'agent-interactive-prompt'
  }
]

describe('detectTerminalWaitBlockedReason live prompts', () => {
  for (const prompt of LIVE_CODEX_PROMPTS) {
    it(`still blocks on a live ${prompt.name} prompt after long scrollback`, () => {
      const waitText = waitTextFor([
        ...codexScrollback([QUOTED_DETECTOR_SOURCE_LINE, QUOTED_PERMISSION_FIXTURE_LINE], 300),
        ...prompt.lines
      ])

      expect(detectTerminalWaitBlockedReason(waitText)).toBe(prompt.reason)
    })

    it(`blocks on a live ${prompt.name} prompt rendered with blank spacer rows`, () => {
      // Why: the visible-screen probe joins raw rows, so blank rows between dialog lines must not eat the window.
      const spaced = prompt.lines.flatMap((line) => [line, '', ''])
      const screen = [
        ' >_ OpenAI Codex (v0.153.3)',
        '',
        ...spaced,
        '',
        '  gpt-6-astra medium · ~/orca/workspaces/orca/fix-wait-detector-scrollback',
        ''
      ].join('\n')

      expect(detectTerminalWaitBlockedReason(screen)).toBe(prompt.reason)
    })
  }

  it('reports the newest prompt when a live dialog follows a stale one at the bottom', () => {
    const waitText = waitTextFor([
      'Update available! 0.131.0 -> 0.132.0',
      'Press enter to continue',
      ' >_ OpenAI Codex (v0.132.0)',
      ' model:       gpt-5.5 high   /model to change',
      ' directory:   ~/orca/workspaces/orca/cli-debug',
      'Hooks need review',
      'Press enter to confirm'
    ])

    expect(detectTerminalWaitBlockedReason(waitText)).toBe('agent-hooks-review-prompt')
  })
})

// Why: these matchers never inspect the pane's agent, so a Codex-named reason on a non-Codex screen
// reaches the user verbatim through the CLI and the worker receipt's "Agent startup blocked:" line.
describe('detectTerminalWaitBlockedReason on non-Codex agents', () => {
  const NON_CODEX_PROMPTS: { name: string; lines: string[]; reason: string }[] = [
    {
      name: 'an Antigravity workspace trust dialog',
      lines: [
        'Antigravity CLI 1.0.3',
        'Do you trust the files in this folder?',
        '1. Yes, I trust this folder',
        '2. No, exit'
      ],
      reason: 'agent-trust-workspace'
    },
    {
      name: 'a Claude Code trusted-workspace dialog',
      lines: [
        'Claude Code',
        'Trusted workspace?',
        'This directory has not been opened before.',
        '1. Yes, proceed',
        '2. No, exit'
      ],
      reason: 'agent-trust-workspace'
    },
    {
      name: 'a Gemini CLI update banner',
      lines: [
        'Gemini CLI',
        'Update available! 1.4.0 -> 1.5.0',
        '1. Update now',
        '2. Skip',
        'Press enter to continue'
      ],
      reason: 'agent-update-prompt'
    },
    {
      name: 'a Gemini CLI permission dialog',
      lines: [
        'Gemini CLI',
        'Permission required',
        'Running this tool requires permission',
        'Allow once',
        'Allow always',
        'Reject'
      ],
      reason: 'agent-interactive-prompt'
    },
    {
      name: 'a Claude Code hooks review dialog',
      lines: [
        'Claude Code',
        'Hooks need review',
        'PreToolUse:Bash  .claude/hooks/guard.sh',
        'Press enter to confirm'
      ],
      reason: 'agent-hooks-review-prompt'
    },
    {
      name: 'an Antigravity sandbox confirmation',
      lines: [
        'Antigravity CLI 1.0.3',
        'This action runs outside the sandbox.',
        'Press enter to confirm or esc to go back'
      ],
      reason: 'agent-interactive-prompt'
    }
  ]

  // Why: the reason was previously picked by looking for 'codex' in 600 chars of scrollback, so any
  // agent that merely narrated about Codex handed its user a Codex label.
  it('does not borrow a Codex label from scrollback that only mentions Codex', () => {
    const waitText = waitTextFor([
      'Antigravity CLI 1.0.3',
      'I read src/codex-notes.md for you.',
      'This action runs outside the sandbox.',
      'Press enter to confirm or esc to go back'
    ])

    expect(waitText.toLowerCase()).toContain('codex')
    expect(detectTerminalWaitBlockedReason(waitText)).toBe('agent-interactive-prompt')
  })

  for (const prompt of NON_CODEX_PROMPTS) {
    it(`reports an agent-neutral reason for ${prompt.name}`, () => {
      const waitText = waitTextFor(prompt.lines)
      const reason = detectTerminalWaitBlockedReason(waitText)

      expect(waitText.toLowerCase()).not.toContain('codex')
      expect(reason).toBe(prompt.reason)
      expect(reason?.startsWith('codex-')).toBe(false)
    })
  }
})

// Antigravity readiness, and what this file does NOT claim about it.
//
// The detector recognizes a ready screen by the Antigravity header and a lone '>' caret. Model
// names are not part of the signal: the logo can prefix the row, and Antigravity can run models
// other than Gemini. Dialog selections keep their labels after '>', so they remain distinguishable.
describe('Antigravity readiness does not absorb its own startup dialog', () => {
  const TRUST_DIALOG_WITH_CARET = [
    'Antigravity CLI 1.0.3',
    'Do you trust the files in this folder?',
    '1. Yes, I trust this folder',
    '2. No, exit',
    '> Yes, I trust this folder'
  ]

  const LIVE_DIALOGS_UNDER_THE_HEADER: { name: string; lines: string[]; reason: string | null }[] =
    [
      {
        name: 'a bare trust dialog',
        lines: TRUST_DIALOG_WITH_CARET,
        reason: 'agent-trust-workspace'
      },
      {
        name: 'a trust dialog with an ordinary sentence in it',
        lines: [
          'Antigravity CLI 1.0.3',
          'This workspace has not been opened before.',
          'Do you trust the files in this folder?',
          '1. Yes, I trust this folder',
          '2. No, exit',
          '> Yes, I trust this folder'
        ],
        reason: 'agent-trust-workspace'
      },
      {
        name: 'a trust dialog printing the folder on its own line',
        lines: [
          'Antigravity CLI 1.0.3',
          'Do you trust the files in this folder?',
          '~/orca/workspaces/orca/agy-dispatch-issue',
          '1. Yes',
          '2. No',
          '> Yes'
        ],
        reason: 'agent-trust-workspace'
      }
    ]

  for (const dialog of LIVE_DIALOGS_UNDER_THE_HEADER) {
    it(`reports ${dialog.name} drawn under the header and stays unready`, () => {
      const waitText = waitTextFor(dialog.lines)

      expect(detectTerminalWaitBlockedReason(waitText)).toBe(dialog.reason)
      expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    })
  }

  // Discriminating: the Gemini model line and caret satisfy readiness, so only the dialog sitting
  // *below* them keeps this unready. Drop the ordering rule and this goes green-to-red.
  it('keeps reporting a dialog that opens after a Gemini ready screen', () => {
    const waitText = waitTextFor([
      'Antigravity CLI 1.0.3',
      'user@example.com (Antigravity Business)',
      'Gemini 3.5 Flash (High)',
      '~/orca/workspaces/orca/agy-dispatch-issue',
      '>',
      'Permission required',
      'Allow once',
      'Reject'
    ])

    expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    expect(detectTerminalWaitBlockedReason(waitText)).toBe('agent-interactive-prompt')
  })

  it('rejects a stale composer caret while the Antigravity model picker is active', () => {
    const waitText = waitTextFor([
      'Antigravity CLI 1.2.0',
      '>',
      'Switch Model',
      '> Gemini 3.8 Flash',
      'Gemini 3.7 Flash (current)',
      'Keyboard: ↑/↓ Navigate · enter Select · esc Go Back'
    ])

    expect(isKnownReadyPromptPreview(waitText)).toBe(false)
  })

  // Discriminating: a stale dialog above a reprinted Gemini ready screen must stop being reported,
  // which is the whole point of the dismissed-modal rule.
  it('clears once a Gemini ready screen replaces the dialog', () => {
    const waitText = waitTextFor([
      ...TRUST_DIALOG_WITH_CARET,
      'Antigravity CLI 1.0.3',
      'user@example.com (Antigravity Business)',
      'Gemini 3.5 Flash (High)',
      '>'
    ])

    expect(isKnownReadyPromptPreview(waitText)).toBe(true)
    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
  })

  it('recognizes a non-Gemini ready screen', () => {
    const waitText = waitTextFor([
      'Antigravity CLI 1.0.3',
      'user@example.com (Antigravity Business)',
      'Claude Sonnet 4.5 (High)',
      '~/orca/workspaces/orca/agy-dispatch-issue',
      '>'
    ])

    expect(isKnownReadyPromptPreview(waitText)).toBe(true)
  })

  it('rejects a visible unsent draft whose wrap continuation is a bare caret', () => {
    const waitText = waitTextFor([
      'Antigravity CLI 1.2.1',
      'Gemini 3.7 Flash (Low)',
      '────────────────────────────────────────',
      '> abc',
      '  >',
      '────────────────────────────────────────',
      'Gemini 3.7 Flash · low'
    ])

    expect(isKnownReadyPromptPreview(waitText)).toBe(false)
  })

  // Ratchet: these dialogs must remain unready because their selection row is not a bare caret.
  const SILENT_STARTUP_DIALOGS: { name: string; lines: string[] }[] = [
    {
      name: 'an update banner',
      lines: [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'A new version is available',
        '~/orca/workspaces/orca/agy-dispatch-issue',
        'Press enter to continue',
        '> Continue'
      ]
    },
    {
      name: 'a sign-in dialog',
      lines: [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'Sign in to continue',
        '~/orca/workspaces/orca/agy-dispatch-issue',
        '1. Open browser',
        '2. Paste an API key',
        '> Open browser'
      ]
    },
    {
      name: 'a model picker',
      lines: [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'Select a model',
        '~/orca/workspaces/orca/agy-dispatch-issue',
        '1. Claude Sonnet 4.5',
        '2. GPT-5.1',
        '> Claude Sonnet 4.5'
      ]
    },
    {
      name: 'a privacy notice',
      lines: [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'We collect usage data to improve the product',
        '~/orca/workspaces/orca/agy-dispatch-issue',
        '1. Accept',
        '2. Decline',
        '> Accept'
      ]
    },
    {
      name: 'an onboarding theme picker',
      lines: [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'Welcome! Choose a theme',
        '~/orca/workspaces/orca/agy-dispatch-issue',
        '1. Dark',
        '2. Light',
        '> Dark'
      ]
    }
  ]

  for (const dialog of SILENT_STARTUP_DIALOGS) {
    it(`refuses ${dialog.name} whose wording names no blocked reason, account row and all`, () => {
      const waitText = waitTextFor(dialog.lines)

      // No blocked-signal rule matches, so the ordering defense cannot reach these: readiness has to
      // refuse them on its own or the orchestrator types into a live dialog.
      expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
      expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    })

    it(`refuses ${dialog.name} that merely narrates an email address`, () => {
      const waitText = waitTextFor([
        ...dialog.lines.slice(0, -1),
        'contact support@antigravity.dev for help',
        '> Selected option'
      ])

      expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    })
  }
})
