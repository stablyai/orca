// RS-1: `claude setup-token` output and pasted codes as Claude Code really produces them. Every fixture
// below is built from Claude Code 2.1.323's own bundled source (read from the installed CLI binary, never
// run): the success block is
//   ✓ Long-lived authentication token created successfully!      (Ink <Text color="success">)
//   Your OAuth token (valid for <duration>):                      (gap: 1 between rows)
//   <token>                                                       (Ink <Text color="warning">, wraps at width)
//   Store this token securely. You won't be able to see it again.
//   Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
// the sign-in link is an OSC 8 hyperlink (`assumeSupport: true`) around the dim URL text, the prompt is
// "Paste code here if prompted > ", and a pasted line is trimmed and split on '#': without both halves the
// CLI answers "Invalid code. Please make sure the full code was copied."; a code from another sign-in gets
// "That code is not from this sign-in. Paste the code shown after opening the address above."; a code the
// server refuses gets "That code wasn't accepted. It may be incomplete, expired, …". A pseudo-terminal
// ends every line with CRLF. All tokens and codes here are fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findAuthorizeUrl,
  findSetupToken,
  runClaudeSetupToken,
  type SetupTokenProcess
} from './claude-setup-token-runner'
import { normalizeClaudeSetupCode } from './claude-setup-code'

const TOKEN = `sk-ant-oat01-${'Zz9_-q'.repeat(16)}`
const AUTHORIZE =
  'https://claude.ai/oauth/authorize?code=true&client_id=fake&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=FAKEstate0123456789'
const ESC = '\u001b'
const green = (text: string) => `${ESC}[32m${text}${ESC}[39m`
const yellow = (text: string) => `${ESC}[33m${text}${ESC}[39m`
const dim = (text: string) => `${ESC}[2m${text}${ESC}[22m`
const osc8 = (url: string, text: string) => `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`
const crlf = (...lines: string[]) => lines.join('\r\n')

function successBlock(tokenRows: string[]): string {
  return crlf(
    '',
    green('✓ Long-lived authentication token created successfully!'),
    '',
    'Your OAuth token (valid for 1 year):',
    '',
    ...tokenRows.map(yellow),
    '',
    dim("Store this token securely. You won't be able to see it again."),
    '',
    dim('Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>'),
    ''
  )
}

describe('findSetupToken on real output (Claude Code 2.1.323)', () => {
  it('reads the token from the CRLF, coloured success block, ignoring the "<token>" hint line', () => {
    expect(findSetupToken(successBlock([TOKEN]), false)).toBe(TOKEN)
  })

  it('a token Ink wrapped at the terminal width is joined, never captured cut short', () => {
    for (const width of [40, 64, 80]) {
      const rows = TOKEN.match(new RegExp(`.{1,${width}}`, 'g')) ?? []
      expect(rows.length).toBeGreaterThan(1)
      expect(findSetupToken(successBlock(rows), false)).toBe(TOKEN)
    }
  })

  it('a wrapped row padded with trailing spaces (Ink fills the line) still joins', () => {
    const rows = [`${TOKEN.slice(0, 50)}   `, TOKEN.slice(50)]
    expect(findSetupToken(successBlock(rows), false)).toBe(TOKEN)
  })

  it('a banner before and trailing lines after never extend or replace the token', () => {
    const banner = crlf(`${ESC}[?25l${ESC}[2K${ESC}[1G${dim('Welcome to Claude Code')}`, '')
    const after = crlf('', `${ESC}[?25h`, 'Press Enter to continue')
    expect(findSetupToken(`${banner}${successBlock([TOKEN])}${after}`, false)).toBe(TOKEN)
  })
})

describe('findAuthorizeUrl on real output (Claude Code 2.1.323)', () => {
  it('finds the link inside its OSC 8 hyperlink, with CRLF around it', () => {
    const screen = crlf(
      `${dim("Browser didn't open? Use the url below to sign in ")}claude.ai`,
      osc8(AUTHORIZE, dim(AUTHORIZE)),
      '',
      'Paste code here if prompted > '
    )
    expect(findAuthorizeUrl(screen)).toBe(AUTHORIZE)
  })
})

describe('normalizeClaudeSetupCode on real pastes', () => {
  const CODE = 'FAKEcode0123456789abcdef#FAKEstate0123456789'
  it('takes the bare code#state and the full callback URL, both as code#state', () => {
    expect(normalizeClaudeSetupCode(` ${CODE}\r\n`)).toBe(CODE)
    expect(
      normalizeClaudeSetupCode(
        'https://platform.claude.com/oauth/code/callback?code=FAKEcode0123456789abcdef&state=FAKEstate0123456789'
      )
    ).toBe(CODE)
  })
  it('joins a code copied across a wrapped line', () => {
    expect(normalizeClaudeSetupCode('FAKEcode0123\n456789abcdef#FAKEstate01234\r\n56789')).toBe(
      CODE
    )
  })
  it('refuses a code without its state (the CLI would answer "Invalid code")', () => {
    expect(normalizeClaudeSetupCode('FAKEcode0123456789abcdef')).toBeNull()
    expect(
      normalizeClaudeSetupCode(
        'https://platform.claude.com/oauth/code/callback?code=FAKEcode0123456789abcdef'
      )
    ).toBeNull()
  })
})

describe('runClaudeSetupToken: the CLI refusing a pasted code (Claude Code 2.1.323 wording)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const refusal of [
    'Invalid code. Please make sure the full code was copied.',
    'That code is not from this sign-in. Paste the code shown after opening the address above.',
    "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code."
  ]) {
    it(`starts over on "${refusal.slice(0, 32)}…"`, async () => {
      let onData: (chunk: string) => void = () => {}
      const writes: string[] = []
      const child: SetupTokenProcess = {
        onData: (listener) => {
          onData = listener
        },
        onExit: () => {},
        kill: () => {},
        write: (data) => void writes.push(data)
      }
      const submits: ((code: string) => boolean)[] = []
      const onCodeRejected = vi.fn()
      const controller = new AbortController()
      void runClaudeSetupToken({
        spawn: async () => child,
        signal: controller.signal,
        timeoutMs: 60_000,
        onAcceptsCode: (submit) => void submits.push(submit),
        onCodeRejected
      })
      await vi.advanceTimersByTimeAsync(0)
      onData(crlf(osc8(AUTHORIZE, AUTHORIZE), 'Paste code here if prompted > '))
      expect(submits[0]?.('FAKEcode0123456789abcdef#FAKEstate0123456789')).toBe(true)
      await vi.advanceTimersByTimeAsync(200)
      onData(crlf('', refusal, 'Paste code here if prompted > '))
      expect(onCodeRejected).toHaveBeenCalledTimes(1)
      controller.abort()
    })
  }
})
