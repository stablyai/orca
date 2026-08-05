// The adapter's behavioural contract: what it sends, what it refuses, and what
// it can never turn into an approval.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  MEDIATED_RETRIEVAL_ENABLED,
  NO_TOOLS_LIMITS,
  type NoToolsReasonCode
} from '../../shared/audited-audit-mode-types'
import { runNoToolsAudit } from './audited-no-tools-adapter'
import type { BundleInput } from './audited-no-tools-bundle'
import {
  setNoToolsDispatcherForTests,
  type NoToolsDispatchArgs,
  type NoToolsTransportResult
} from './audited-no-tools-transport'
import { decideCodeAuditOutcome } from './audited-code-audit-outcome'

let root: string
/** Every turn the adapter dispatched, so a test can inspect what was SENT. */
let sent: NoToolsDispatchArgs[]

const APPROVED_JSON = '{"verdict":"approved","summary":"Looks correct.","findings":[]}'

/** Appears only inside a retrievable file, never in the bundle. */
const RETRIEVAL_MARKER = 'ONLY-REACHABLE-BY-RETRIEVAL'

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-adapter-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42\n')
  writeFileSync(join(root, 'secret.pem'), 'PRIVATE KEY\n')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  setNoToolsDispatcherForTests(undefined)
})

/** Installs a dispatcher that replies with each text in turn. */
function replyWith(...replies: NoToolsTransportResult[]): void {
  sent = []
  let index = 0
  setNoToolsDispatcherForTests(async (args) => {
    sent.push(args)
    const reply = replies[index] ?? replies.at(-1)!
    index += 1
    return reply
  })
}

function bundle(overrides: Partial<BundleInput> = {}): BundleInput {
  return {
    title: 'Add a thing',
    description: 'It should do the thing.',
    acceptanceCriteria: [{ id: 'ac1', text: 'Does the thing', covered: false }],
    planText: null,
    diffStat: ' src/index.ts | 1 +',
    diff: '--- a/src/index.ts\n+++ b/src/index.ts\n+export const answer = 42\n',
    files: [],
    redactionContext: {},
    ...overrides
  }
}

describe('a verdict is produced only from a real model answer', () => {
  it('returns the final message in band on a clean turn', async () => {
    replyWith({ ok: true, text: APPROVED_JSON })

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })

    expect(outcome.kind).toBe('exit')
    expect(outcome.kind === 'exit' && outcome.exitCode).toBe(0)
    // Carried IN BAND rather than through a file: the adapter writes nothing.
    expect(outcome.kind === 'exit' && outcome.lastMessage).toBe(APPROVED_JSON)
  })

  it('sends the system prompt and the bundle, and nothing else', async () => {
    replyWith({ ok: true, text: APPROVED_JSON })
    await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })

    expect(sent).toHaveLength(1)
    const [system, user] = sent[0].messages
    expect(system.role).toBe('system')
    expect(system.content).toContain('NO tools')
    expect(user.role).toBe('user')
    expect(user.content).toContain('Add a thing')
    expect(user.content).toContain('[ac1] Does the thing')
  })
})

describe('no transport failure can become an approval', () => {
  const TRANSPORT_FAILURES: NoToolsReasonCode[] = [
    'api_unauthorized',
    'api_rate_limited',
    'api_unavailable',
    'api_timeout',
    'response_malformed',
    'context_limit_exceeded'
  ]

  it.each(TRANSPORT_FAILURES)('%s blocks instead of approving', async (reasonCode) => {
    replyWith({ ok: false, reasonCode })

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })
    expect(outcome.kind).toBe('no_tools_failed')

    // The end-to-end property that matters: run the outcome through the SAME
    // decision function production uses, and confirm no verdict emerges.
    const decision = decideCodeAuditOutcome({
      outcome,
      driftReasonCode: null,
      parsed: null,
      fixRound: 0,
      maxFixRounds: 3
    })
    expect(decision.verdict).toBeNull()
    expect(decision.status).toBe('failed')
    expect(decision.toState).toBe('blocked')
    expect(decision.reasonCode).toBe(reasonCode)
  })

  it('a malformed verdict does not approve', async () => {
    replyWith({ ok: true, text: 'I think it looks fine to me, ship it!' })

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })
    // The adapter exits 0 — the TRANSPORT succeeded. Fail-closed lives in the
    // shared verdict parser, which is where the CLI path's guarantee lives too.
    expect(outcome.kind).toBe('exit')

    const { parsePlanAuditVerdict } = await import('./audited-plan-audit-verdict')
    const parsed = parsePlanAuditVerdict(outcome.kind === 'exit' ? (outcome.lastMessage ?? '') : '')
    expect(parsed.ok).toBe(false)

    const decision = decideCodeAuditOutcome({
      outcome,
      driftReasonCode: null,
      parsed,
      fixRound: 0,
      maxFixRounds: 3
    })
    expect(decision.verdict).toBeNull()
    expect(decision.reasonCode).toBe('verdict_unparseable')
  })
})

describe('bundle limits fail closed before anything is sent', () => {
  it('refuses an over-cap file set without dispatching', async () => {
    replyWith({ ok: true, text: APPROVED_JSON })

    const tooManyFiles = Array.from(
      { length: NO_TOOLS_LIMITS.maxBundleFiles + 1 },
      (_unused, index) => ({ relativePath: `src/f${index}.ts`, contents: 'x' })
    )
    const outcome = await runNoToolsAudit({
      bundle: bundle({ files: tooManyFiles }),
      scopeRoot: root
    })

    expect(outcome).toEqual({ kind: 'no_tools_failed', reasonCode: 'bundle_too_large' })
    // THE POINT: no bytes left the machine.
    expect(sent).toHaveLength(0)
  })

  it('refuses an over-cap single file without dispatching', async () => {
    replyWith({ ok: true, text: APPROVED_JSON })

    const outcome = await runNoToolsAudit({
      bundle: bundle({
        files: [{ relativePath: 'big.ts', contents: 'x'.repeat(NO_TOOLS_LIMITS.maxFileBytes + 1) }]
      }),
      scopeRoot: root
    })

    expect(outcome).toEqual({ kind: 'no_tools_failed', reasonCode: 'bundle_too_large' })
    expect(sent).toHaveLength(0)
  })
})

describe('redaction happens before dispatch', () => {
  it('scrubs identity values out of every section', async () => {
    replyWith({ ok: true, text: APPROVED_JSON })

    await runNoToolsAudit({
      bundle: bundle({
        description: `Fix the bug in ${root} on branch feature/secret-name`,
        diff: `--- a${root}/src/index.ts\n+++ b/src/index.ts\n`,
        redactionContext: { worktreePath: root, branchName: 'feature/secret-name' }
      }),
      scopeRoot: root
    })

    const payload = sent[0].messages.map((message) => message.content).join('\n')
    expect(payload).not.toContain(root)
    expect(payload).not.toContain('feature/secret-name')
  })

  it('scrubs a credential-shaped token out of the diff', async () => {
    replyWith({ ok: true, text: APPROVED_JSON })

    const token = `github_pat_${'A'.repeat(30)}`
    await runNoToolsAudit({
      bundle: bundle({ diff: `+const token = '${token}'\n` }),
      scopeRoot: root
    })

    expect(sent[0].messages.map((m) => m.content).join('\n')).not.toContain(token)
  })
})

describe('mediated retrieval is DISABLED for the first release', () => {
  it('dispatches NO follow-up turn when the model asks for files', async () => {
    // THE RELEASE REGRESSION. An in-scope, perfectly well-formed request — the
    // case that WOULD have been served — must now end the audit, and crucially
    // must not produce a second dispatch.
    replyWith(
      { ok: true, text: '{"needFiles":["src/index.ts"],"reason":"need context"}' },
      { ok: true, text: APPROVED_JSON }
    )

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })

    expect(outcome).toEqual({ kind: 'no_tools_failed', reasonCode: 'context_request_invalid' })
    // EXACTLY ONE turn. A second entry would mean a follow-up was dispatched.
    expect(sent).toHaveLength(1)
  })

  it('never sends retrieved file contents even for a legal in-scope path', async () => {
    // A file whose contents appear NOWHERE in the bundle, so a match could only
    // come from retrieval. (src/index.ts would be a false positive: the bundle's
    // diff legitimately quotes it.)
    writeFileSync(join(root, 'src', 'secretish.ts'), `const marker = '${RETRIEVAL_MARKER}'\n`)
    replyWith(
      { ok: true, text: '{"needFiles":["src/secretish.ts"]}' },
      { ok: true, text: APPROVED_JSON }
    )

    await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })

    // The file exists and is in scope, so this proves the refusal is the
    // capability being off — not the path failing validation.
    const everythingSent = sent.flatMap((turn) => turn.messages.map((m) => m.content)).join('\n')
    expect(everythingSent).not.toContain(RETRIEVAL_MARKER)
  })

  it('pins the shipped configuration', () => {
    // Both guards, asserted independently: either alone stops a dispatch, so a
    // future diff flipping one without the other cannot silently open the path.
    expect(MEDIATED_RETRIEVAL_ENABLED).toBe(false)
    expect(NO_TOOLS_LIMITS.maxFollowUpTurns).toBe(0)
  })

  it('does not advertise the affordance in the prompt', async () => {
    const { buildNoToolsSystemPrompt } = await import('./audited-no-tools-prompt')
    const prompt = buildNoToolsSystemPrompt()

    // Offering a request the adapter must refuse would turn a cooperative model
    // into a failed audit.
    expect(prompt).not.toContain('needFiles')
    expect(prompt).toContain('cannot request additional files')
  })

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a traversal', '../../etc/passwd'],
    ['an out-of-scope suffix', 'secret.pem'],
    ['a nonexistent file', 'does-not-exist.ts']
  ])('BLOCKS THE WHOLE AUDIT on %s', async (_label, path) => {
    replyWith(
      { ok: true, text: JSON.stringify({ needFiles: [path] }) },
      { ok: true, text: APPROVED_JSON }
    )

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })

    // The audit ends — never "skip the bad path and continue", which would let a
    // model probe the filesystem one refusal at a time. While retrieval is
    // disabled these are refused BEFORE scope validation even runs; the scope
    // rules themselves stay pinned by audited-no-tools-scope.test.ts, so
    // enabling the capability later cannot ship an unvalidated path.
    expect(outcome).toEqual({ kind: 'no_tools_failed', reasonCode: 'context_request_invalid' })
    expect(sent).toHaveLength(1)
  })

  it('refuses a mixed request even though one path is legal', async () => {
    replyWith({ ok: true, text: JSON.stringify({ needFiles: ['src/index.ts', '/etc/passwd'] }) })

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })
    // All-or-nothing: a partially-served request must not exist.
    expect(outcome).toEqual({ kind: 'no_tools_failed', reasonCode: 'context_request_invalid' })
  })

  it('cannot loop, however many times the model asks', async () => {
    // A model that only ever emits requests must still terminate after ONE
    // dispatch. Previously this exhausted a turn budget; with retrieval
    // disabled it is refused outright, and the bound is now structural.
    replyWith({ ok: true, text: '{"needFiles":["src/index.ts"]}' })

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })

    expect(outcome).toEqual({ kind: 'no_tools_failed', reasonCode: 'context_request_invalid' })
    expect(sent).toHaveLength(1)
  })

  it('rejects a request carrying an unexpected key', async () => {
    // `.strict()` on the schema: an invented "command" key means the model is
    // not following the protocol, so the reply is not treated as a request at
    // all and falls through to verdict parsing, which fails closed.
    replyWith({ ok: true, text: '{"needFiles":["src/index.ts"],"command":"rm -rf /"}' })

    const outcome = await runNoToolsAudit({ bundle: bundle(), scopeRoot: root })
    expect(outcome.kind).toBe('exit')

    const { parsePlanAuditVerdict } = await import('./audited-plan-audit-verdict')
    expect(
      parsePlanAuditVerdict(outcome.kind === 'exit' ? (outcome.lastMessage ?? '') : '').ok
    ).toBe(false)
  })
})
