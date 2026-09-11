// The guard exists because any readiness detector can be wrong, so this suite is a
// two-sided corpus rather than a handful of examples: every LIVE_CREDENTIAL_SURFACE must
// block, and every LEGITIMATE_AGENT_SCREEN must not. A false negative types the user's task
// prompt into a credential field; a false positive only defers until the dialog is answered.
import { describe, expect, it } from 'vitest'
import {
  findCredentialPromptIndex,
  TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE
} from './terminal-credential-prompt-detection'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'
import { TERMINAL_TITLE_CLASSIFICATION_CORPUS } from '../../shared/terminal-title-classification-corpus'

function screen(lines: string[]): string {
  return lines.join('\n')
}

const LIVE_CREDENTIAL_SURFACES: readonly (readonly [string, string[]])[] = [
  [
    'antigravity device-code sign-in drawn over ready chrome (#19749)',
    [
      'Antigravity CLI',
      'gemini 3 pro (high)',
      '~/orca/workspaces/orca/crash-closer',
      '>',
      '',
      '  Sign in to Antigravity',
      '  Open https://antigravity.google/device and enter the code: KXTD-9PQR',
      '  Waiting for authentication…'
    ]
  ],
  [
    'antigravity auth-method menu over ready chrome',
    [
      'Antigravity CLI',
      'gemini 3 pro (high)',
      '>',
      '',
      '? How would you like to authenticate?',
      '❯ Sign in with Google',
      '  Use an API key'
    ]
  ],
  [
    'api-key prompt under a complete Codex ready header',
    [
      'OpenAI Codex',
      'model: gpt-6',
      'directory: ~/repo',
      '',
      '› Ask Codex to do anything',
      '',
      'Enter your API key:'
    ]
  ],
  ['bare api-key ask', ['Enter your API key: ']],
  ['vendor-qualified api-key ask with a caret', ['? Enter your Anthropic API key ›']],
  ['bare password label', ['Password:']],
  ['lowercase password label', ['password: ']],
  ['sudo password', ['[sudo] password for neil:']],
  ['ssh key passphrase', ["Enter passphrase for key '/Users/neil/.ssh/id_ed25519':"]],
  ['git username', ["Username for 'https://github.com': "]],
  ['git password', ["Password for 'https://neil@github.com': "]],
  ['sms verification code', ['Enter the verification code we sent to your phone:']],
  ['one-time code', ['Enter your one-time code:']],
  [
    'two-factor dialog',
    ['Two-factor authentication', 'Enter the 6-digit code from your authenticator app:']
  ],
  ['personal access token paste', ['Paste your personal access token here:']],
  ['sign-in wall', ['Authentication required', 'Sign in with GitHub to continue']],
  [
    'oauth device-code flow',
    [
      'Please open the following url in your browser:',
      '  https://github.com/login/device',
      '',
      'and enter the code: ABCD-1234'
    ]
  ],
  ['client secret', ['Enter client secret:']],
  ['password confirmation', ['Re-enter password:']],
  ['access token ask', ['Provide your access token:']],
  ['otp ask', ['Type your OTP:']],
  ['bare credentials label', ['credentials:']],
  ['device code ask', ['Enter device code:']],
  [
    'gh auth login device code',
    [
      '! First copy your one-time code: 1A2B-3C4D',
      'Press Enter to open github.com in your browser...'
    ]
  ],
  [
    'claude /login paste-code screen',
    [
      "Browser didn't open? Use the url below to sign in:",
      'https://claude.ai/oauth/authorize?code=true',
      'Paste code here if prompted >'
    ]
  ],
  // The dialog this guard was written for (F19749-1). A numbered menu of credential actions
  // ending in a bare `>` caret: no terminator anywhere, so only the row-final noun carries it.
  [
    'antigravity sign-in menu over ready chrome',
    [
      'Antigravity CLI 1.0.3',
      'user@example.com (Antigravity Business)',
      'Sign in to continue',
      '~/orca/workspaces/orca/agy-dispatch-issue',
      '1. Open browser',
      '2. Paste an API key',
      '>'
    ]
  ],
  ['vendor-qualified indented api-key ask', ['  Enter your Antigravity API key:']],
  // sudo translates its prompt but never its `[sudo]` tag, and the only thing it asks for is a
  // password. An English-only rule here misses every non-English desktop.
  ['sudo password on a German system', ['[sudo] Passwort für neil:']],
  ['sudo password on a zh-TW system', ['[sudo] neil 的密碼：']],
  ['sudo retry notice', ['[sudo] Sorry, try again.', '[sudo] password for neil:']],
  // The common api-key ask names the env var it fills, so the noun carries an underscore.
  [
    'aider env-var api-key ask',
    ['Aider v0.86.1', 'Model: gpt-6 with diff edit format', '', 'Enter your OPENAI_API_KEY:']
  ],
  ['bare env-var api-key label', ['ANTHROPIC_API_KEY:']],
  ['waiting on the user to sign in', ['Waiting for you to sign in…']],
  [
    'crush api-key onboarding dialog',
    [
      '╭─ Crush ──────────╮',
      '│  Connect your model provider           │',
      '│  Paste your API key here:              │',
      '╰────────────╯'
    ]
  ]
]

const LEGITIMATE_AGENT_SCREENS: readonly (readonly [string, string[]])[] = [
  // An agent narrating credential work and returning to its composer.
  [
    'codex narrating password hashing',
    [
      '• I added bcrypt password hashing to src/auth/user.ts.',
      '',
      '› Ask Codex to do anything',
      '',
      '  gpt-6 medium · ~/repo'
    ]
  ],
  [
    'codex narrating api-key wiring',
    ['• Wired the API key into .env.example and documented it.', '', '› Ask Codex to do anything']
  ],
  [
    'claude narrating login work',
    ['· Updated the login form to use the new session cookie.', '', '✳ Claude Code', '', '> ']
  ],
  [
    'codex narrating an oauth refresh',
    [
      '• Done. The OAuth device-code flow now refreshes the access token.',
      '',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'claude narrating a secret rotation',
    ['· I rotated the client secret and pushed the change.', '', '> ']
  ],
  // An agent legitimately ASKING the user something credential-adjacent.
  [
    'agent asks where to store a password',
    [
      '· Should I store the password in the .env file or in the keychain?',
      '',
      '✳ Claude Code',
      '',
      '> '
    ]
  ],
  [
    'agent asks about reading an api key',
    ['· Do you want me to read your api key from process.env.OPENAI_API_KEY?', '', '> ']
  ],
  [
    'agent asks which auth provider',
    ['· Which auth provider should the sign in page use?', '', '> ']
  ],
  [
    'agent asks about a token in CI',
    ['· I need to know: does your CI already have a personal access token?', '', '> ']
  ],
  [
    'agent asks where a template goes',
    ['· Where should I put the verification code template?', '', '> ']
  ],
  ['agent asks about OTP expiry', ['· Should the OTP expire after 5 minutes or 10?', '', '> ']],
  [
    'agent asks about 2FA delivery',
    ['· Do you want 2FA codes emailed or via authenticator app?', '', '> ']
  ],
  [
    'agent narrates an upcoming passphrase edit',
    ['· Ready. Next I will enter the passphrase handling into the key loader.', '', '> ']
  ],
  [
    'agent narrates an api-key edit mid-sentence',
    ['· I will enter the API key into the vault once you confirm the vault name', '', '> ']
  ],
  [
    'agent asks which secret key to rotate',
    ['· Please tell me which secret key you want rotated first', '', '> ']
  ],
  // The user's own task prompt echoed above the composer.
  ['echoed login task prompt', ['> Implement the login form', '', '· Working…']],
  [
    'echoed password-reset task prompt',
    ['> add password reset via one-time code', '', '· Working…']
  ],
  [
    'echoed credentials task prompt',
    ['> Refactor the credentials module', '', '✳ Claude Code', '', '> ']
  ],
  // Search output quoting credential-shaped source, the shape that broke earlier detectors.
  [
    'rg hit on a password call',
    [
      '  └ src/auth.ts:42:  const password = await promptPassword()',
      '',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'rg hit on an api-key label literal',
    ["  └ 118:    label: 'Enter your API key'", '', '› Ask Codex to do anything']
  ],
  [
    'rg hit on a password test name',
    ["  └ tests/auth.test.ts:9:  it('prompts for password', () => {", '', '> ']
  ],
  [
    'search narration quoting a prompt',
    ['  └ Search "enter your password" in src/', '', '› Ask Codex to do anything']
  ],
  // A diff that ADDS a credential prompt string.
  [
    'diff adding an api-key log',
    ['+  console.log("Enter your API key:")', '', '› Ask Codex to do anything']
  ],
  ['diff adding a password prompt field', ['+    prompt: "Password:"', '', '> ']],
  // Other terminal traffic.
  [
    'cursor approval menu',
    [
      'Run this command?',
      '  cat ~/.ssh/id_rsa',
      '  Run (once) (enter)',
      '  Skip & tell the agent (esc)'
    ]
  ],
  [
    'vitest auth suite output',
    [
      '  ✓ auth > rejects an expired access token (4 ms)',
      '  ✓ auth > hashes the password with argon2 (9 ms)',
      '',
      'Test Files  1 passed'
    ]
  ],
  [
    'jest login suite output',
    ['PASS src/login.test.ts', '', '  ● login form › submits credentials', '', '> ']
  ],
  [
    'git push rejection',
    [
      'remote: Support for password authentication was removed.',
      'fatal: Authentication failed',
      '$ '
    ]
  ],
  ['clean git push', ['Everything up-to-date', '$ ']],
  [
    'rendered readme auth section',
    ['## Authentication', '', 'Set `ORCA_API_KEY` in your environment before running.', '', '$ ']
  ],
  [
    'agent narrating a failed gh auth',
    [
      '• The gh CLI says authentication failed; I skipped the PR step.',
      '',
      '› Ask Codex to do anything'
    ]
  ],
  // An agent SUMMARISING auth work it just finished, with its own composer on the last row.
  // These pair an auth verb with an auth-flow phrase, which is the shape that used to match
  // with no prompt terminator and no position requirement at all.
  [
    'codex summarising two-factor work',
    [
      '• I implemented two-factor authentication for the login flow.',
      '  The authenticator app now generates a 6-digit code.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'claude summarising two-factor work',
    [
      '· Added two-factor authentication. Tests for the authenticator app pass.',
      '✳ Claude Code',
      '> '
    ]
  ],
  [
    'codex summarising a sign-in button',
    [
      '• Added a Sign in with Google button; it logs the authorization result.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'codex reporting an auth error it hit',
    [
      '  └ ERROR: authentication required. Please sign in with the CLI.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'agent asking whether MFA is wanted',
    ['· Should the app require MFA, or is authentication via password enough?', '> ']
  ],
  [
    'codex summarising a device-code flow it built',
    [
      '• The OAuth flow now shows a device code and waits for authentication.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'rg hit on auth documentation',
    ['  └ docs/auth.md:12: Users authenticate with the authenticator app.', '> ']
  ],
  [
    'rg hits on a login component',
    [
      '  └ src/Login.tsx:31:  <button>Sign in with GitHub</button>',
      '  └ src/Login.tsx:44:  // authorization code exchange',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'codex reporting MFA tests passing',
    ['• All MFA tests pass; authentication is wired end to end.', '› Ask Codex to do anything']
  ],
  [
    'codex quoting a build failure',
    [
      "• The build failed: 'authorization required'. You need to log in with `vercel login`.",
      '› Ask Codex to do anything'
    ]
  ],
  [
    'rg hit on a readme auth section',
    [
      '  └ docs/auth.md:3: ## Authentication',
      '    Users sign in with GitHub or an authenticator app.',
      '> '
    ]
  ],
  [
    'claude summarising an oauth change',
    [
      '· Done — the OAuth login now requires authentication via the device code flow.',
      '✳ Claude Code',
      '> '
    ]
  ],
  [
    'gemini summarising SSO work',
    ['✦ Added SSO. Users authenticate with Okta; the sign in with SAML path is tested.', '◇ ']
  ],
  [
    'opencode wrapping an auth summary',
    [
      'Added requireAuth middleware. Unauthenticated requests get 401; sign in with the',
      'token endpoint returns a JWT.',
      '❯ '
    ]
  ],
  [
    'stack trace over a codex composer',
    [
      'Error: authentication required',
      '    at signInWithToken (auth.ts:22)',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'shell deploy failure',
    [
      'Running deploy...',
      'ERROR: authentication required',
      'Please sign in with the CLI and retry.',
      'exit code 1'
    ]
  ],
  // Printed config whose bare `password:` label is not the screen's bottom row.
  [
    'printed kubernetes secret manifest',
    ['kind: Secret', 'stringData:', '      password:', '› Ask Codex to do anything']
  ],
  [
    'printed signup form template',
    [
      '• The signup form now has these fields:',
      '  email:',
      '  password:',
      '› Ask Codex to do anything'
    ]
  ],
  // Records, not requests: the auth phrase is quoted inside a line whose subject is something
  // else, and nothing under it repaints a composer caret.
  [
    'git log ending on a sign-in commit subject',
    [
      '$ git log --oneline -3',
      'a1b2c3d fix(auth): drop the stale authorization header',
      'd4e5f6a feat(auth): sign in with GitHub'
    ]
  ],
  ['single sign-in commit subject', ['d4e5f6a feat(auth): sign in with GitHub']],
  [
    'changelog entry for a sign-in feature',
    ['## Unreleased', '- feat(auth): sign in with Apple support']
  ],
  [
    'checklist item for a sign-in button',
    ['Plan:', '  [x] add session cookie', '  [ ] add sign in with Google button']
  ],
  [
    'error summary quoting an auth failure',
    ['• Fixed the deploy step', '• Root cause: authentication required from the vercel CLI']
  ],
  [
    'rg hits ending the screen on a sign-in match',
    [
      '$ rg "sign in with" src/',
      'src/Login.tsx:31:  <button>Sign in with GitHub</button>',
      'src/Login.tsx:44:  // authorization code exchange happens here'
    ]
  ],
  // "waiting for you to ..." is how every agent narrates waiting on a human, auth or not.
  [
    'agent waiting on a diff review after login work',
    ['• Updated the login page copy', 'Waiting for you to review the diff']
  ],
  [
    'agent waiting on a branch choice after authorization work',
    ['• Rebased the authorization middleware', 'Waiting for you to choose a base branch']
  ],
  // Localized narration: the wording it embeds is English, the punctuation is not.
  [
    'zh-TW narration of a failed deploy on the bottom row',
    ['$ pnpm deploy', '錯誤：authentication required，請先執行 gh auth login']
  ],
  [
    'german narration of login work on the bottom row',
    [
      '• Anmeldung überarbeitet',
      '• Der Nutzer kann sich jetzt per sign in with Google authentifizieren'
    ]
  ],
  // The sibling dialogs of the Antigravity sign-in menu, same chrome and same bare `>` caret.
  [
    'antigravity model picker',
    [
      'Antigravity CLI 1.0.3',
      'user@example.com (Antigravity Business)',
      'Select a model',
      '~/orca/workspaces/orca/agy-dispatch-issue',
      '1. Claude Sonnet 4.5',
      '2. GPT-5.1',
      '>'
    ]
  ],
  [
    'antigravity privacy notice',
    [
      'Antigravity CLI 1.0.3',
      'We collect usage data to improve the product',
      '1. Accept',
      '2. Decline',
      '>'
    ]
  ],
  [
    'dotenv example printed by the agent',
    ['$ cat .env.example', 'DATABASE_URL=', 'API_KEY=', 'SESSION_SECRET=']
  ],
  // Plain source code printed into the pane -- the category this corpus lacked. It had `rg` hits
  // and diffs, which carry their own chrome, but not bare formatted source. Every line below was
  // mined from this repo's tracked files and refused a prompt above a real composer caret: oxfmt
  // renders a ternary consequent as a bare `?` row (5,666 tracked files have one), `.login` reads
  // as the auth verb "log in", and prose that merely ENDS on a credential noun read as an ask.
  [
    'ternary consequent with a sign-in string',
    [
      "      ? 'Update desktop Orca and sign in to connect from anywhere'",
      '› Ask Codex to do anything'
    ]
  ],
  [
    'ternary consequent with an authentication template literal',
    ['        ? `replacement session authentication timed out (${stage})`', '> ']
  ],
  [
    'ternary consequent with a login error',
    ['              ? `Codex login failed: ${trimmedOutput}`', '❯ ']
  ],
  [
    'ternary consequent calling a login spawn builder',
    [
      "      ? buildWindowsHostInteractiveLoginSpawn(codexCommand, ['login'])",
      '› Ask Codex to do anything'
    ]
  ],
  [
    'ternary consequent with a sign-in status string',
    ["        ? 'Timed out while checking Codex sign-in status'", '> ']
  ],
  [
    'ternary consequent reading an authorization basis',
    ['        ? this.originPool.controlForBasis(authorization.basisConnId)', '❯ ']
  ],
  [
    'ternary consequent building a gh auth command',
    ['    ? `gh auth login --hostname ${host}`', '› Ask Codex to do anything']
  ],
  [
    'ternary consequent with a translated sign-in-again label',
    ["                ? translate('settings.signInAgain', 'Sign in again')", '❯ ']
  ],
  [
    'ternary consequent with a pat docs url',
    [
      "        ? 'https://learn.microsoft.com/azure/devops/accounts/use-pat-to-authenticate'",
      '› Ask Codex to do anything'
    ]
  ],
  [
    'ternary filtering assignees by login',
    ['    ? prevAssignees.filter((l) => l !== login)', '› Ask Codex to do anything']
  ],
  [
    'ternary narrowing a login to a string',
    ["            ? overrides.filter((login): login is string => typeof login === 'string')", '> ']
  ],
  [
    'ternary removing assignees by login',
    ['                          ? { removeAssignees: [user.login] }', '❯ ']
  ],
  [
    'ternary mapping project assignees',
    [
      '                  ? projectRowDetail.assignees.map((login) => ({',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'ternary removing a reviewer by login',
    ['      ? handleRemoveReviewers([reviewer.login])', '> ']
  ],
  [
    'ternary editing assignees by login',
    ['                      ? onEditAssignees?.([], [user.login])', '❯ ']
  ],
  [
    'ternary lowercasing an assignee login',
    [
      '        ? prevAssignees.filter((user) => user.login.toLowerCase() !== lowerLogin)',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'ternary building an assignee removal patch',
    ["        ? { family: 'assignees', kind: 'remove', logins: [login] }", '❯ ']
  ],
  [
    'wrapped comment ending on a credential noun',
    ['    // Why: a merely missing or expired bundle must not enter the credential', '❯ ']
  ],
  [
    'wrapped comment ending on a password noun',
    ['    // The caller must provide the current password', '› Ask Codex to do anything']
  ],
  [
    'wrapped jsdoc ending on an api key noun',
    ['   * Callers are expected to paste their API key', '> ']
  ],
  // No caret, and the bottom row DOES lead with an action phrase, so the only thing keeping this
  // from reading as a live prompt is that `candidate.login` is a property access.
  [
    'source comment leading with an action phrase, corroborated by the comment above it',
    [
      '    // See the authentication guide for details',
      '    // Sign in with the provider console to continue'
    ]
  ],
  [
    'source rows where a .credential access is the only would-be credential noun',
    ['    const owner = candidate.credential', '    Enter the code below to finish linking']
  ],
  [
    'bare identifier ternary above a codex caret and its model footer',
    ['      ? login', '', '\u203a Ask Codex to do anything', '', '  gpt-6 medium \u00b7 ~/repo']
  ],
  [
    'bare identifier ternary above an opencode caret and status bar',
    ['      ? authorization', '', '\u276f ', 'opencode  anthropic/claude-opus-4  ~/repo']
  ],
  [
    'ternary above a codex caret and its model footer',
    [
      "      ? 'Update desktop Orca and sign in to connect from anywhere'",
      '',
      '\u203a Ask Codex to do anything',
      '',
      '  gpt-6 medium \u00b7 ~/repo'
    ]
  ],
  [
    'login access above an opencode caret and status bar',
    [
      '        ? prevAssignees.filter((user) => user.login.toLowerCase() !== lowerLogin)',
      '',
      '\u276f ',
      'opencode  anthropic/claude-opus-4  ~/repo'
    ]
  ],
  [
    'personal_access_token identifier cannot corroborate',
    ['    const owner = candidate.personal_access_token', '    Enter the code below to finish']
  ],
  [
    'source rows where a .login access is the only would-be auth verb',
    [
      '    const owner = candidate.login',
      '    // Enter the code below to finish linking the account'
    ]
  ]
]

describe('findCredentialPromptIndex', () => {
  it.each(LIVE_CREDENTIAL_SURFACES)('blocks %s', (_name, lines) => {
    expect(findCredentialPromptIndex(screen(lines).toLowerCase())).not.toBeNull()
  })

  it.each(LEGITIMATE_AGENT_SCREENS)('does not fire on %s', (_name, lines) => {
    expect(findCredentialPromptIndex(screen(lines).toLowerCase())).toBeNull()
  })

  it('ignores an answered credential prompt that scrolled out of the live window', () => {
    const tail = screen([
      'Enter your API key:',
      '',
      'Signed in as neil@example.com.',
      '',
      'OpenAI Codex',
      'model: gpt-6',
      'directory: ~/repo',
      '',
      '› Ask Codex to do anything'
    ])
    expect(findCredentialPromptIndex(tail.toLowerCase())).toBeNull()
    expect(detectTerminalWaitBlockedReason(tail)).toBeNull()
  })

  it('keeps the sentinel a superset of everything the detector matches', () => {
    // The retained-tail index skips any tail the sentinel rejects, so a detector match the
    // sentinel misses would never be parsed at all.
    for (const [name, lines] of LIVE_CREDENTIAL_SURFACES) {
      const matched = lines.some((line) => TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE.test(line))
      expect(matched, name).toBe(true)
    }
  })

  it('keeps the sentinel a superset over every screen, not just the ones we expect to block', () => {
    // Why both corpora: asserting the superset only over screens we already believe block makes
    // the test as biased as the corpus. The invariant is about the detector's OWN verdict -- any
    // screen it matches must survive the prefilter -- and that is what caught this lane silently
    // passing the Antigravity sign-in menu.
    for (const [name, lines] of [...LIVE_CREDENTIAL_SURFACES, ...LEGITIMATE_AGENT_SCREENS]) {
      if (findCredentialPromptIndex(screen(lines).toLowerCase()) === null) {
        continue
      }
      const matched = lines.some((line) => TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE.test(line))
      expect(matched, name).toBe(true)
    }
  })

  it('keeps the sentinel linear on adversarial lines', () => {
    // The sentinel runs per retained tail line at streaming rate, so a variable-length prefix
    // inside its noun alternation is not a style question: the obvious way to spell the env-var
    // vendor slot (`(?:[a-z0-9]+_)?api[ _-]?key`) costs 30ms on one 5.5k-char line, ~1000x this
    // budget, and stalls the whole tail index.
    const lines = [
      `${'a'.repeat(5000)}${'_'.repeat(500)}`,
      `${'a_'.repeat(2500)}api key${'x'.repeat(200)}`,
      'passwordx'.repeat(500)
    ]
    const started = performance.now()
    for (let run = 0; run < 100; run += 1) {
      for (const line of lines) {
        TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE.test(line)
      }
    }
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('does not fire on any realistic terminal title', () => {
    for (const title of TERMINAL_TITLE_CLASSIFICATION_CORPUS) {
      expect(findCredentialPromptIndex(title.toLowerCase()), title).toBeNull()
    }
  })
})

describe('credential prompts reach the wait-blocked vocabulary', () => {
  it.each(LIVE_CREDENTIAL_SURFACES)('reports agent-credential-prompt for %s', (_name, lines) => {
    expect(detectTerminalWaitBlockedReason(screen(lines))).toBe('agent-credential-prompt')
  })

  it('refuses to call the #19749 screen a ready prompt', () => {
    // HEAD's Antigravity readiness rule (header, a gemini model row, a lone `>` caret) is all
    // present here, which is exactly why the detector reported ready while the dialog was live.
    const tail = screen([
      'Antigravity CLI',
      'gemini 3 pro (high)',
      '>',
      '',
      '  Sign in to Antigravity',
      '  Open https://antigravity.google/device and enter the code: KXTD-9PQR',
      '  Waiting for authentication…'
    ])
    expect(isKnownReadyPromptPreview(tail)).toBe(false)
    expect(detectTerminalWaitBlockedReason(tail)).toBe('agent-credential-prompt')
  })

  it('is not cleared by a ready caret drawn elsewhere on the screen', () => {
    // Every other blocked reason is dismissible by a live prompt; this one must not be, or the
    // agent's own input box would vouch for the dialog covering it.
    const tail = screen([
      'OpenAI Codex',
      'model: gpt-6',
      'directory: ~/repo',
      '› Ask Codex to do anything',
      '',
      'Authentication required',
      'Sign in with GitHub to continue'
    ])
    expect(detectTerminalWaitBlockedReason(tail)).toBe('agent-credential-prompt')
  })
})
