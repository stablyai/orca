// The STRUCTURAL security properties of the no-tools adapter.
//
// These are source-level assertions, not behavioural ones, and that is
// deliberate: "the key never reaches a child process" cannot be proven by
// running one code path, because the risk is a FUTURE call site added in a diff
// that looks harmless. Reading the source is what makes adding one a deliberate,
// reviewable act rather than an accident.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MODULE_DIR = __dirname

function read(file: string): string {
  return readFileSync(join(MODULE_DIR, file), 'utf8')
}

/**
 * Source with comments removed.
 *
 * The spawn assertions scan for CODE, and these modules discuss runCodexProcess
 * by name in their comments to explain what they deliberately do NOT do. A raw
 * text scan would fail on that documentation — which would train the next author
 * to delete the explanation rather than keep the property.
 */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function sourceFiles(): string[] {
  return readdirSync(MODULE_DIR).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
  )
}

/** The adapter's own modules — the closure a no-tools audit executes within. */
const NO_TOOLS_MODULES = [
  'audited-no-tools-adapter.ts',
  'audited-no-tools-bundle.ts',
  'audited-no-tools-prompt.ts',
  'audited-no-tools-scope.ts',
  'audited-no-tools-transport.ts',
  'audited-no-tools-artifacts.ts'
]

describe('the provider key has exactly one reader', () => {
  it('is read ONLY by the transport module', () => {
    // Comment-stripped: audited-codex-provider-key-store.ts explains in prose
    // why no launch path calls this, and that explanation must not register as a
    // call site.
    const readers = sourceFiles().filter((name) =>
      readCode(name).includes('readAuditedCodexProviderKey')
    )

    // The key store DECLARES it; the transport CONSUMES it. Any third file is a
    // new place a secret could escape, and must be reviewed as such.
    expect(readers.toSorted()).toEqual([
      'audited-codex-provider-key-store.ts',
      'audited-no-tools-transport.ts'
    ])
  })

  it('never places the key in an environment object', () => {
    const transport = read('audited-no-tools-transport.ts')

    // The specific shapes that would hand a secret to a child process. Their
    // absence is what keeps Tranche 2 closed.
    expect(transport).not.toMatch(/process\.env\s*\[/)
    expect(transport).not.toContain('AUDITED_CODEX_ENV_KEY')
    expect(transport).not.toContain('ORCA_AUDITED_CODEX_API_KEY')
    expect(transport).not.toContain('OPENAI_API_KEY')
  })

  it('never logs the key, the header, or the request body', () => {
    const transport = read('audited-no-tools-transport.ts')

    // Every console call in the module, checked for an argument that could
    // carry the secret. A bare string literal is fine; an interpolation of a
    // header or body object is not.
    const logCalls = transport.match(/console\.\w+\([^)]*\)/g) ?? []
    for (const call of logCalls) {
      expect(call).not.toContain('headers')
      expect(call).not.toContain('Authorization')
      expect(call).not.toContain('body')
      expect(call).not.toContain('apiKey')
    }
  })

  it('does not return the key from any exported function', () => {
    const transport = read('audited-no-tools-transport.ts')
    // buildAuthorizedHeaders is the only function holding the value, and it is
    // module-private. An exported one could be called from anywhere.
    expect(transport).toContain('function buildAuthorizedHeaders()')
    expect(transport).not.toContain('export function buildAuthorizedHeaders')
  })

  it('keeps the exported request builder free of the credential', () => {
    // buildResponsesRequestBody IS exported, for contract tests. It must
    // therefore be provably incapable of reaching the key: it takes the model
    // and messages as parameters and calls nothing that reads storage.
    const transport = readCode('audited-no-tools-transport.ts')
    const builder = transport.slice(
      transport.indexOf('export function buildResponsesRequestBody'),
      transport.indexOf('export async function dispatchNoToolsTurn')
    )
    expect(builder).not.toContain('readAuditedCodexProviderKey')
    expect(builder).not.toContain('Authorization')
    expect(builder).not.toContain('buildAuthorizedHeaders')
  })

  it('never persists the key or a request body to disk', () => {
    const transport = readCode('audited-no-tools-transport.ts')
    // No filesystem writer of any kind: a debug dump of a request is the most
    // plausible accidental persistence path for a credential.
    expect(transport).not.toContain('writeFile')
    expect(transport).not.toContain('appendFile')
    expect(transport).not.toContain('createWriteStream')
    expect(transport).not.toContain('node:fs')
  })

  it('logs no request or response CONTENT anywhere in the adapter closure', () => {
    for (const name of NO_TOOLS_MODULES) {
      const logCalls = readCode(name).match(/console\.\w+\([^)]*\)/g) ?? []
      for (const call of logCalls) {
        // Interpolating any of these would put model-influenced or
        // credential-adjacent content into a log file or bug report.
        //
        // `response.status` is deliberately PERMITTED and excluded below: an
        // HTTP status is an integer that aids diagnosis and can carry nothing
        // sensitive. What must never appear is a body, a header, or a key.
        // Only INTERPOLATED expressions can carry data; a fixed string literal
        // cannot, however its prose reads. Extracting `${...}` spans is what
        // separates "logs a variable" from "mentions a word".
        const interpolations = (call.match(/\$\{[^}]*\}/g) ?? []).join(' ')
        const withoutStatus = interpolations.replace(/response\.status/g, '')
        expect(withoutStatus, `${name}: ${call}`).not.toContain('response')
        expect(withoutStatus, `${name}: ${call}`).not.toContain('body')
        expect(withoutStatus, `${name}: ${call}`).not.toContain('apiKey')
        expect(withoutStatus, `${name}: ${call}`).not.toContain('text')
        expect(withoutStatus, `${name}: ${call}`).not.toContain('header')
      }
    }
  })
})

// Raw source here, NOT readCode: the comment stripper is a blunt regex that
// also eats `//` inside template literals and regexes, which is fine for the
// spawn scan but would hide the very URL these cases assert on. The risk it
// guards against elsewhere — prose mentioning a forbidden name — does not apply,
// because these are positive assertions about strings that must be present.
describe('the transport speaks the declared wire protocol', () => {
  it('targets /responses, matching the registry wireApi', () => {
    const transport = read('audited-no-tools-transport.ts')
    // The registry says `responses` and audited-codex-launch-plan passes that
    // same value to Codex, so the two transports must not diverge.
    expect(transport).toContain('/responses`')
    // And the registry it must agree with still declares that protocol.
    expect(read('audited-codex-provider-registry.ts')).toContain("wireApi: 'responses'")
  })

  it('builds the request with Responses field names', () => {
    const transport = read('audited-no-tools-transport.ts')
    const builder = transport.slice(
      transport.indexOf('export function buildResponsesRequestBody'),
      transport.indexOf('export async function dispatchNoToolsTurn')
    )
    expect(builder).toContain('max_output_tokens')
    expect(builder).toContain('input_text')
    expect(builder).toContain('output_text')
    // The chat/completions spellings must not appear in the REQUEST BUILDER.
    // (The module header names them in prose to explain the difference, which
    // is why this is scoped to the builder rather than the whole file.)
    expect(builder).not.toContain('max_tokens:')
    // The returned OBJECT must not carry a `messages` key. Scoped to the return
    // statement, since `messages` is also the (legitimate) parameter name.
    const returned = builder.slice(builder.indexOf('return {'))
    expect(returned).not.toMatch(/\bmessages:/)
  })
})

describe('mediated retrieval is off in the shipped configuration', () => {
  it('declares both guards disabled', () => {
    const modes = read('../../shared/audited-audit-mode-types.ts')
    expect(modes).toContain('MEDIATED_RETRIEVAL_ENABLED = false')
    expect(modes).toContain('maxFollowUpTurns: 0')
  })

  it('checks the capability flag before serving any request', () => {
    const adapter = readCode('audited-no-tools-adapter.ts')
    expect(adapter).toContain('if (!MEDIATED_RETRIEVAL_ENABLED)')
    // The refusal must precede the retrieval call in source order, or the guard
    // would be dead code after the read already happened.
    expect(adapter.indexOf('MEDIATED_RETRIEVAL_ENABLED')).toBeLessThan(
      adapter.indexOf('retrieveRequestedFiles(args.scopeRoot')
    )
  })
})

describe('the adapter creates no subprocess', () => {
  it('imports no process-spawning module anywhere in its closure', () => {
    for (const name of NO_TOOLS_MODULES) {
      const source = readCode(name)
      expect(source, `${name} must not spawn`).not.toContain('child_process')
      expect(source, `${name} must not spawn`).not.toContain('spawn(')
      expect(source, `${name} must not spawn`).not.toContain('execFile')
      expect(source, `${name} must not spawn`).not.toContain('runCodexProcess')
    }
  })

  it('declares no tools or function-calling in the request', () => {
    const transport = read('audited-no-tools-transport.ts')
    const body = transport.slice(
      transport.indexOf('const body = JSON.stringify('),
      transport.indexOf('const controller')
    )

    // Their ABSENCE is the no-tools property. A model with no callable surface
    // cannot reach a shell, the filesystem, MCP, a subprocess, or the network.
    expect(body).not.toMatch(/\btools\s*:/)
    expect(body).not.toMatch(/\bfunctions\s*:/)
    expect(body).not.toMatch(/\btool_choice\s*:/)
    expect(body).not.toMatch(/\bfunction_call\s*:/)
  })
})

describe('the endpoint is code-owned', () => {
  it('builds the URL from the registry, never from settings or IPC', () => {
    const transport = read('audited-no-tools-transport.ts')
    expect(transport).toContain('getSoleAuditedCodexProvider()')
    // A caller-chosen base URL plus a main-read credential is an exfiltration
    // primitive, which is why the URL is never a parameter.
    expect(transport).not.toMatch(/baseUrl\s*[:=]\s*args\./)
    expect(transport).toContain("url.startsWith('https://')")
  })
})

describe('credential delivery stays closed', () => {
  it('leaves the Tranche 2 capability constant false', () => {
    const registry = read('audited-codex-provider-registry.ts')
    expect(registry).toContain('AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED = false')
  })

  it('keeps the CLI resolver refusing on a configured provider', () => {
    // The no-tools path is additive. The question "may Codex CLI receive this
    // secret" must still answer no, which is what stops this change from
    // becoming a backdoor reopening of Tranche 2.
    const settings = read('audited-codex-provider-settings.ts')
    const cliResolver = settings.slice(settings.indexOf('resolveAuditedCodexCliProvider'))
    expect(cliResolver).toContain('credential_delivery_unavailable')
  })
})
