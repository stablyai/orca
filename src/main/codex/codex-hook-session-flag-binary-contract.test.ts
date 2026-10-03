import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectHookListings } from './codex-app-server-client'
import { runCodexAppServerSession } from './codex-app-server-session'
import { CODEX_EVENT_LABEL } from './codex-hook-definition'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  CODEX_REQUIRED_EVENTS
} from './codex-hook-session-flags'
import {
  askCodexForHookSessionTrust,
  codexTrustsHookSessionFlag
} from './codex-hook-session-flag-lookup'

// Why this file exists: Orca's status hook rides every native Codex launch as a
// `-c hooks=...` session flag that also carries Codex's approval of it. Only a
// real binary can say whether Codex still (1) reads hooks from the session-flags
// layer, (2) honours an approval from that layer, and (3) hashes the hook the way
// the throwaway-home lookup reported. If any of those drift, a launch would show
// the hook-review screen or lose status, and every unit test here would stay green.

const execFileAsync = promisify(execFile)
const binary = process.env.ORCA_CODEX_HOOK_FLAG_CONTRACT_BINARY
const expectedVersion = process.env.ORCA_CODEX_HOOK_FLAG_CONTRACT_VERSION
const TIMEOUT_MS = 60_000

describe.runIf(process.env.ORCA_CODEX_HOOK_FLAG_CONTRACT_REQUIRED === '1' && !binary)(
  'codex hook session-flag contract prerequisites',
  () => {
    it('was given a Codex binary to run against', () => {
      expect.fail('ORCA_CODEX_HOOK_FLAG_CONTRACT_REQUIRED=1 but no binary was given')
    })
  }
)

describe.runIf(binary)('codex hook session-flag binary contract', { timeout: 180_000 }, () => {
  let root: string
  let hookScript: string
  let hookLog: string
  let hookCommand: string

  beforeAll(async () => {
    // Why a disposable root: never read or start anything under the user's ~/.codex.
    root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-contract-'))
    hookLog = join(root, 'hook-fired.log')
    if (process.platform === 'win32') {
      // Why a bare forward-slash path: the Windows flag carries no quotes, as Orca's own command.
      hookScript = join(root, 'hook.cmd')
      writeFileSync(hookScript, `@more >nul\r\n@echo fired>> "${hookLog}"\r\n`)
      hookCommand = hookScript.replaceAll('\\', '/')
    } else {
      hookScript = join(root, 'hook.sh')
      writeFileSync(hookScript, `#!/bin/sh\ncat >/dev/null\necho fired >> '${hookLog}'\n`)
      chmodSync(hookScript, 0o755)
      hookCommand = `/bin/sh '${hookScript}'`
    }
    const version = await execFileAsync(binary!, ['--version'], {
      timeout: TIMEOUT_MS,
      env: { ...process.env, CODEX_HOME: freshHome('version') }
    })
    if (expectedVersion) {
      expect(version.stdout.trim()).toBe(`codex-cli ${expectedVersion}`)
    }
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function freshHome(name: string): string {
    return mkdtempSync(join(root, `${name}-`))
  }

  async function listHooks(
    flag: string,
    home = freshHome('list')
  ): Promise<ReturnType<typeof collectHookListings>> {
    const result = await runCodexAppServerSession(
      {
        command: binary!,
        args: ['-c', flag, 'app-server'],
        cliPath: binary!,
        env: { CODEX_HOME: home },
        timeoutMs: TIMEOUT_MS
      },
      (rpc) => rpc.request('hooks/list', { cwds: [home] })
    )
    return collectHookListings(result)
  }

  /** The events this Codex lists: every required one, plus Interrupt from the Codex that has it. */
  function expectManagedEvents(labels: readonly string[]): void {
    const required = CODEX_REQUIRED_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName])
    expect([...labels].sort()).toEqual(
      labels.includes(CODEX_EVENT_LABEL.Interrupt)
        ? [...required, CODEX_EVENT_LABEL.Interrupt].sort()
        : [...required].sort()
    )
  }

  const labelOf = (key: string): string => key.split(':').at(-3) ?? ''

  it('reports a key and hash for every managed event of a flag-defined hook', async () => {
    const trust = await askCodexForHookSessionTrust(binary!, hookCommand)
    expect(trust).not.toBeNull()
    expectManagedEvents(Object.keys(trust!))
    for (const [label, entry] of Object.entries(trust!)) {
      expect(entry.key).toMatch(new RegExp(`<session-flags>.*:${label}:0:0$`))
    }
  })

  it('trusts every event it lists, Interrupt included, when the flag carries the reported hashes', async () => {
    const trust = await askCodexForHookSessionTrust(binary!, hookCommand)
    const flag = buildCodexHookSessionFlag(hookCommand, trust!)!
    const listings = (await listHooks(flag)).filter((listing) => listing.source === 'sessionFlags')
    expectManagedEvents(listings.map((listing) => labelOf(listing.key)))
    // Why: a Codex that lists Interrupt must have approved it, or Esc-cancel would open a review.
    expect(listings.map((listing) => labelOf(listing.key)).sort()).toEqual(
      Object.keys(trust!).sort()
    )
    expect(listings.every((listing) => listing.trustStatus === 'trusted')).toBe(true)
    expect(listings.every((listing) => listing.enabled === true)).toBe(true)
  })

  it("confirms the complete flag with Orca's own pre-publish check", async () => {
    const trust = await askCodexForHookSessionTrust(binary!, hookCommand)
    const flag = buildCodexHookSessionFlag(hookCommand, trust!)!
    const wrong = buildCodexHookSessionFlag(
      hookCommand,
      Object.fromEntries(
        Object.entries(trust!).map(([label, entry]) => [
          label,
          { key: entry.key, trustedHash: `sha256:${'0'.repeat(64)}` }
        ])
      )
    )!
    expect(await codexTrustsHookSessionFlag(binary!, flag, hookCommand)).toBe(true)
    expect(await codexTrustsHookSessionFlag(binary!, wrong, hookCommand)).toBe(false)
  })

  it("keeps the hook on over the user's /hooks off switch for it", async () => {
    // Why: Codex writes this when the user switches the hook off in /hooks, and
    // merges it per field; only Orca's own setting may turn its hook off.
    const trust = await askCodexForHookSessionTrust(binary!, hookCommand)
    const home = freshHome('switched-off')
    writeFileSync(
      join(home, 'config.toml'),
      Object.values(trust!)
        .map((entry) => `[hooks.state.${JSON.stringify(entry.key)}]\nenabled = false\n`)
        .join('\n')
    )
    const listings = (
      await listHooks(buildCodexHookSessionFlag(hookCommand, trust!)!, home)
    ).filter((listing) => listing.source === 'sessionFlags')
    expectManagedEvents(listings.map((listing) => labelOf(listing.key)))
    expect(listings.every((listing) => listing.trustStatus === 'trusted')).toBe(true)
    expect(listings.every((listing) => listing.enabled === true)).toBe(true)
  })

  it('puts a flag-defined hook up for review when its approval does not match', async () => {
    // Why: this is why a launch carries the flag only for the version it was derived for.
    const trust = await askCodexForHookSessionTrust(binary!, hookCommand)
    const wrong = Object.fromEntries(
      Object.entries(trust!).map(([label, entry]) => [
        label,
        { key: entry.key, trustedHash: `sha256:${'0'.repeat(64)}` }
      ])
    )
    const listings = (await listHooks(buildCodexHookSessionFlag(hookCommand, wrong)!)).filter(
      (listing) => listing.source === 'sessionFlags'
    )
    expect(listings.every((listing) => listing.trustStatus === 'modified')).toBe(true)
  })

  it('lists the definition flag alone as untrusted, so the approval is what trusts it', async () => {
    const listings = (await listHooks(buildCodexHookDefinitionFlag(hookCommand)!)).filter(
      (listing) => listing.source === 'sessionFlags'
    )
    expectManagedEvents(listings.map((listing) => labelOf(listing.key)))
    expect(listings.every((listing) => listing.trustStatus === 'untrusted')).toBe(true)
  })

  it('runs the approved flag hook in a real turn and writes no hooks file or trust', async () => {
    const trust = await askCodexForHookSessionTrust(binary!, hookCommand)
    const flag = buildCodexHookSessionFlag(hookCommand, trust!)!
    const server = await startMockResponses()
    let stderr = ''
    const home = freshHome('exec')
    try {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      const run = execFileAsync(
        binary!,
        [
          '-c',
          flag,
          '-c',
          'model_provider=mock',
          '-c',
          `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="ORCA_CONTRACT_MOCK_KEY"}`,
          'exec',
          '--skip-git-repo-check',
          'say hi'
        ],
        {
          cwd: home,
          timeout: TIMEOUT_MS,
          env: { ...process.env, CODEX_HOME: home, ORCA_CONTRACT_MOCK_KEY: 'x' }
        }
      )
      // Why: `codex exec` also reads a prompt from stdin until it closes.
      run.child.stdin?.end()
      stderr = (await run).stderr
    } finally {
      server.close()
    }
    expect(readFileSync(hookLog, 'utf-8')).toContain('fired')
    // Why: a Codex that predates Interrupt must drop its definition silently, and no hook may need review.
    expect(stderr).not.toMatch(/interrupt|clamp|review|untrusted/i)
    expect(readdirSync(home)).not.toContain('hooks.json')
    const config = readdirSync(home).includes('config.toml')
      ? readFileSync(join(home, 'config.toml'), 'utf-8')
      : ''
    expect(config).not.toContain('hooks.state')
  })
})

/** A minimal Responses stream: one assistant message, then completion. */
function startMockResponses(): Promise<Server> {
  const event = (payload: Record<string, unknown>): string =>
    `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
        response.writeHead(404).end()
        return
      }
      const id = 'resp_contract'
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        event({ type: 'response.created', response: { id } }) +
          event({
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              id: 'msg_contract',
              content: [{ type: 'output_text', text: 'hi' }]
            }
          }) +
          event({
            type: 'response.completed',
            response: {
              id,
              usage: {
                input_tokens: 0,
                input_tokens_details: null,
                output_tokens: 0,
                output_tokens_details: null,
                total_tokens: 0
              }
            }
          })
      )
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}
