import { afterAll, expect, it, vi } from 'vitest'
import {
  realKimiPrOutput,
  realKimiOccupiedOutput,
  sourceShapedKimiOutput
} from '../../shared/__fixtures__/kimi-generation-source-shaped'
import type * as DnsDiagnosticModule from '../network/macos-tailscale-dns-diagnostic'
import { finalizeFromAgentOutput } from './source-control-agent-failure'

const log = vi.spyOn(console, 'error').mockImplementation(() => {})
afterAll(() => log.mockRestore())
vi.mock('../network/macos-tailscale-dns-diagnostic', async (original) => {
  const actual = await original<typeof DnsDiagnosticModule>()
  return {
    ...actual,
    withMacTailscaleDnsHint: (message: string, detail?: string | null) =>
      actual.withMacTailscaleDnsHintForDiagnostic(message, detail, {
        globalNameservers: ['100.100.100.100']
      })
  }
})
const invalid = /Kimi returned output Orca couldn't read\. Try again\./
const occupied = /Kimi.*active in another client.*Stop.*exit.*try again/
const unknown = /^Kimi couldn't finish.*execution host.*check.*retrying/
const earlier = sourceShapedKimiOutput('Earlier answer')
const run = (message: string) => `error: failed to run prompt: ${message}\nSee log: private-path`
const network = run('provider.connection_error: getaddrinfo ENOTFOUND private-host')
const agentOptions =
  /^Kimi received conflicting or repeated agent options\. Keep a single --agent or --agent-file option in the generation recipe or CLI arguments, then retry\.$/
const credentials = /credentials.*execution host.*configure.*sign in/
const parser =
  /^Kimi rejected an option or argument\. Correct the generation recipe or CLI arguments, then retry\.$/
const delimiters = "private-x' argument '".repeat(12)

// Source-shaped stderr forms come from the official 2.3.1 terminal error routes.
it.each([
  ['', occupied, realKimiOccupiedOutput, 4],
  [run('unrelated private-prose'), occupied, `${earlier}\n${realKimiOccupiedOutput}`, 4],
  [run('Session "private-session" not found.'), /find.*session.*existing session.*new one/],
  [
    run('Session "private-session" was created under a different directory.'),
    /another directory.*Resume it there.*workspace/
  ],
  [
    run('no provider configured; complete onboarding via /login or the providers endpoint'),
    credentials
  ],
  [
    run(
      'Provider "private-provider" declares api_key_env = "PRIVATE_ENV" in config.toml, but the environment variable is not set or is empty.'
    ),
    /credential environment variable.*Set it.*execution host/
  ],
  [
    run('model private-model does not resolve to a configured provider'),
    /usable model.*configure or select/
  ],
  [run('Prompt hook blocked the request.'), /hook blocked.*Review.*hooks.*retry/],
  [run('Prompt turn ended with reason: cancelled'), /cancelled.*Try again/],
  [
    run('provider.auth_error: private-provider prose'),
    /authenticate.*Sign in.*credentials.*retry/,
    '{broken'
  ],
  [run('provider.rate_limit: private-provider prose'), /limit.*Wait.*reduce/],
  [run('Provider safety policy blocked the response.'), /blocked.*Revise.*prompt.*configuration/],
  [run('context.overflow: private-provider prose'), /context.*Shorten.*new session/],
  [run('config.invalid: private-provider prose'), /invalid configuration.*Check.*model.*provider/],
  [network, /connect.*network.*retry/],
  [network, /connect.*network.*MagicDNS/, '', 1, true],
  ...[
    "error: option '--agent <name>' cannot be used with option '--agent-file <path>'",
    "error: option '--agent-file <path>' argument 'private-b.md' is invalid. --agent-file may only be specified once.",
    "error: option '--agent <name>' argument 'private-'other' is invalid. --agent may only be specified once."
  ].map((stderr) => [stderr, agentOptions] as const),
  ...[
    "error: option '--agent <name>' argument missing",
    "error: unknown option '--private-flag'\n(Did you mean --plan?)",
    "unknown command 'private-word'. See 'kimi --help'.",
    "error: option '--agent-file <path>' argument 'private-value' is invalid. --agent may only be specified once.",
    "error: option '--agent <name>' argument 'private-value' is invalid. provider.auth_error: private-prose",
    "error: option '--private-flag' cannot be used with option '--private-other'"
  ].map((stderr) => [stderr, parser] as const),
  [run("unknown option '--private-flag'"), unknown, '{"type":"error","code":"unknown.code"}'],
  [`error: option '${delimiters}tail`, unknown],
  [`error: option '${delimiters}value' is invalid. provider.auth_error: private-prose`, parser],
  ['error: Login required\n\nmessage:\nprivate-prose\nSee log: private-path', credentials],
  ['error: Prompt cannot be empty.', /empty prompt.*recipe.*CLI arguments/],
  [
    'error: Cannot combine --prompt with --auto.',
    /conflicting.*--prompt.*--auto.*recipe.*arguments/
  ],
  [
    'error: Cannot combine --agent/--agent-file with --session/--continue: the agent is bound at session creation and the bound agent is restored automatically on resume.',
    /cannot change the agent.*Remove.*override.*new session/
  ],
  ['error: Cannot use --session without an id in prompt mode.', /session id.*recipe.*arguments/],
  ["hook narration error: unknown option '--private-flag'", unknown],
  ['', /Kimi.*interrupted.*Try again/, '', null],
  ['', invalid, realKimiOccupiedOutput, 0],
  [
    run('provider.auth_error: private-prose'),
    /Kimi returned an empty message\.$/,
    sourceShapedKimiOutput(),
    0
  ],
  ['', /"title":"Decode Kimi generation output.*\\n\\n/, realKimiPrOutput, 0],
  ...[
    '{"role":',
    'NOTICE wrapper log',
    '{"role":"assistant","content":42}',
    '{"role":"assistant","tool_calls":"bad"}',
    '{"role":"tool","content":"missing id"}'
  ].map((bad) => ['', invalid, `${earlier}\n${bad}`, 0] as const)
] as const)('%s outcome', (stderr, meaning, stdout = '', code = 1, local: boolean = false) => {
  const result = finalizeFromAgentOutput({
    stdout,
    stderr,
    code,
    includeLocalMacDnsHint: local,
    label: 'Kimi',
    operation: 'commit-message',
    outputFormat: 'kimi-stream-json'
  })
  expect(result.success).toBe(stdout === realKimiPrOutput)
  const text = result.success ? result.rawOutput : result.error
  expect(text).toMatch(meaning)
  expect(text).not.toMatch(
    /private-|PRIVATE_ENV|CODE_SECRET|provider\.[a-z_]+|session\.occupied|unknown\.code|code [014]/
  )
  if (!local) {
    expect(text).not.toContain('MagicDNS')
  }
  if (!result.success && (stdout || stderr)) {
    expect(result.failureOutput).toEqual({ label: 'Kimi', exitCode: code, stdout, stderr })
  }
})

it('codes a diagnosed failure so clients can translate it, keeping the English error', () => {
  const result = finalizeFromAgentOutput({
    stdout: '',
    stderr: 'error: Cannot combine --prompt with --auto.',
    code: 1,
    includeLocalMacDnsHint: false,
    label: 'Kimi',
    operation: 'commit-message',
    outputFormat: 'kimi-stream-json'
  })
  expect(result).toMatchObject({
    success: false,
    error:
      'Kimi received conflicting options: --prompt with --auto. Correct the generation recipe or CLI arguments before retrying.',
    errorCode: 'kimiConflictingOptions',
    errorParams: { option: '--prompt', otherOption: '--auto' }
  })
})
