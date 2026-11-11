import { describe, expect, it } from 'vitest'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview,
  isMuseReadyPromptPreview
} from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

// Agents print rg hits from this detector into scrollback; quoted source must not masquerade as a live prompt.
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
    '• Ran rg -n "press enter to confirm" src/main/runtime/terminal/wait/terminal-wait-detection.ts src/main/runtime/orca-runtime-tests/agent-status-and-waits.spec.ts',
    '  └ src/main/runtime/terminal/wait/terminal-wait-detection.ts',
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
  it('ignores quoted prompt wording just above the live-dialog window', () => {
    // Why 10: with the 3-line idle screen the quoted lines sit 13-14 non-blank lines from the bottom.
    const waitText = waitTextFor([
      ...codexScrollback([QUOTED_DETECTOR_SOURCE_LINE, QUOTED_PERMISSION_FIXTURE_LINE], 10),
      ...codexIdleScreen()
    ])

    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
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

// Matchers lack agent identity; provider-specific reason text reaches unrelated agents' CLI/worker receipts verbatim.

// Antigravity readiness uses its header and bare caret; models vary and dialog selections retain labels after >.
describe('Antigravity readiness does not absorb its own startup dialog', () => {
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

      // No blocked-signal rule matches; readiness itself must reject these dialogs to prevent injection.
      expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
      expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    })
  }
})

// Muse 1.3.0 node-pty capture: echo-provider ready screen with trust flag, plus trust dialog without it.

const MUSE_READY_SCREEN_META = [
  '  Muse Code 1.3.0',
  '  Skills: 77 loaded · 1 warning · 28 details hidden (ctrl+o to expand)',
  '── Voice input (⌥ + v to start) ──────────────────────────────────────────',
  '❯ ────────────────────────────────────────────────────────────────────',
  '  muse-spark-1.3 · max · ~/Downloads/interview-coach · YOLO'
]

const MUSE_TRUST_DIALOG = [
  'Do you trust this workspace?',
  'Workspace: /private/tmp',
  'Trusting allows project-local skills, rules, hooks, and plugin config to load before the model runs.',
  'Only trust this workspace when you trust its contents.',
  '> 1  Trust and continue',
  '  2  Quit',
  'Use Up/Down or 1/2, then Enter. Esc quits.'
]

describe('isMuseReadyPromptPreview', () => {
  it('recognizes a composer without the voice-input label (#25005)', () => {
    expect(
      isMuseReadyPromptPreview(
        waitTextFor(['  Muse Code 1.4.2', '──────────────────────────❯ ──────────────────────────'])
      )
    ).toBe(true)
  })

  it('refuses a bare Muse mention without its composer', () => {
    expect(isMuseReadyPromptPreview(waitTextFor(['comparing Muse Code vs codex']))).toBe(false)
    expect(
      isMuseReadyPromptPreview(waitTextFor(['Muse Code 1.3.0', '  echo · /private/tmp · YOLO']))
    ).toBe(false)
    expect(isMuseReadyPromptPreview(waitTextFor(['Muse Code 1.4.2 (1.4.2-R1)', '~/app ❯']))).toBe(
      false
    )
    expect(isMuseReadyPromptPreview(waitTextFor(['Muse Code 1.4.2', '╭─ ~/app', '╰─❯']))).toBe(
      false
    )
  })

  it('dismisses a trust dialog once Muse paints its ready screen', () => {
    const waitText = waitTextFor([...MUSE_TRUST_DIALOG, ...MUSE_READY_SCREEN_META])
    expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
    expect(isMuseReadyPromptPreview(waitText)).toBe(true)
  })

  it('refuses a ready screen once a blocked dialog opens below it', () => {
    const waitText = waitTextFor([...MUSE_READY_SCREEN_META, ...MUSE_TRUST_DIALOG])
    expect(detectTerminalWaitBlockedReason(waitText)).toBe('agent-trust-workspace')
    expect(isMuseReadyPromptPreview(waitText)).toBe(false)
  })
})
