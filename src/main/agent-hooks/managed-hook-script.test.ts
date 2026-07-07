import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildPosixManagedHookScript,
  buildWindowsEndpointSubroutineLines,
  buildWindowsEndpointLoadLine
} from './managed-hook-script'

describe('buildPosixManagedHookScript — static invariants', () => {
  const script = buildPosixManagedHookScript({ source: 'claude' })

  it('parses the endpoint file instead of sourcing it', () => {
    // Sourcing (`. "$file"`) executes arbitrary shell in that path; the managed
    // script must never do that.
    expect(script).not.toContain('. "$ORCA_AGENT_HOOK_ENDPOINT"')
    expect(script).toContain('done < "$ORCA_AGENT_HOOK_ENDPOINT"')
  })

  it('sends the token as a header (matching the other hook transports)', () => {
    expect(script).toContain('-H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}"')
  })

  it('keeps the payload off the command line (read from a temp file)', () => {
    expect(script).not.toContain('--data-urlencode "payload=${payload}"')
    expect(script).toContain('--data-urlencode "payload@${__orca_payload_file}"')
  })

  it('bypasses any configured proxy for the loopback POST', () => {
    expect(script).toContain('--noproxy 127.0.0.1')
  })

  it('validates the port as digits-only before using it in the URL', () => {
    expect(script).toContain('""|*[!0-9]*) exit 0 ;;')
  })
})

describe('buildWindowsEndpointSubroutineLines — static invariants', () => {
  it('parses the endpoint file with for/f rather than call-executing it', () => {
    const lines = buildWindowsEndpointSubroutineLines().join('\r\n')
    expect(buildWindowsEndpointLoadLine()).toBe('call :__orcaLoadEndpoint')
    expect(lines).toContain('for /f "usebackq eol=# tokens=1,* delims=="')
    // The load path must never `call` the endpoint file (which would run it).
    expect(lines).not.toContain('call "%ORCA_AGENT_HOOK_ENDPOINT%"')
  })
})

// Functional round-trip: the generated POSIX script must actually deliver the
// hook to a loopback listener, and must NOT execute the endpoint file. Requires
// /bin/sh + mktemp + curl, so it is POSIX-only.
describe.skipIf(process.platform === 'win32')('buildPosixManagedHookScript — behavior', () => {
  let server: Server
  let port: number
  let dir: string
  let scriptPath: string
  let received: {
    path?: string
    token?: string | undefined
    payload?: string
    hookEventName?: string
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'managed-hook-'))
    scriptPath = join(dir, 'hook.sh')
    writeFileSync(scriptPath, buildPosixManagedHookScript({ source: 'claude' }), { mode: 0o755 })
    received = {}
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString())
        received = {
          path: req.url,
          token: req.headers['x-orca-agent-hook-token'] as string | undefined,
          payload: body.get('payload') ?? undefined,
          hookEventName: body.get('hook_event_name') ?? undefined
        }
        res.writeHead(200)
        res.end('ok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeEndpoint(extraLines: string[] = []): string {
    const p = join(dir, 'endpoint.env')
    writeFileSync(
      p,
      [
        `ORCA_AGENT_HOOK_PORT=${port}`,
        'ORCA_AGENT_HOOK_TOKEN=tok-DEADBEEF-42',
        'ORCA_AGENT_HOOK_ENV=production',
        'ORCA_AGENT_HOOK_VERSION=1.2.3',
        ...extraLines,
        ''
      ].join('\n')
    )
    return p
  }

  // Why: drive the script with async spawn, not execFileSync — a synchronous
  // child blocks node's event loop so the in-process HTTP listener could never
  // accept the loopback POST, and curl would spuriously time out.
  function run(env: Record<string, string>, payload: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [scriptPath], { env: { ...process.env, ...env } })
      let stdout = ''
      child.stdout.on('data', (c) => {
        stdout += String(c)
      })
      child.on('error', reject)
      child.on('close', () => resolve({ stdout }))
      child.stdin.end(payload)
    })
  }

  it('delivers the payload and streams the token as a header', async () => {
    const endpoint = writeEndpoint()
    const { stdout } = await run(
      { ORCA_AGENT_HOOK_ENDPOINT: endpoint, ORCA_PANE_KEY: 'pane-1' },
      '{"secret":"hi there"}'
    )
    expect(received.path).toBe('/hook/claude')
    expect(received.token).toBe('tok-DEADBEEF-42')
    expect(received.payload).toBe('{"secret":"hi there"}')
    // Claude appends UserPromptSubmit hook stdout to the prompt — the claude
    // script (no prelude) must print nothing on stdout.
    expect(stdout).toBe('')
  })

  it('prints nothing on stdout even when it cannot create the temp file', async () => {
    const endpoint = writeEndpoint()
    // Point TMPDIR at a non-writable/nonexistent dir so mktemp fails; the hook
    // must fail open silently, never leaking mktemp's error into Claude's prompt.
    const { stdout } = await run(
      { ORCA_AGENT_HOOK_ENDPOINT: endpoint, ORCA_PANE_KEY: 'pane-x', TMPDIR: join(dir, 'nope') },
      '{"a":1}'
    )
    expect(stdout).toBe('')
    expect(received.path).toBeUndefined()
  })

  it('parses the endpoint file without executing shell inside it', async () => {
    // If the file were sourced, this command substitution would create a marker.
    const marker = join(dir, 'PWNED')
    const endpoint = writeEndpoint([
      `ORCA_AGENT_HOOK_ENV=$(touch ${marker})`,
      `\`touch ${marker}2\``
    ])
    await run({ ORCA_AGENT_HOOK_ENDPOINT: endpoint, ORCA_PANE_KEY: 'pane-2' }, '{"x":1}')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(`${marker}2`)).toBe(false)
    // Junk lines are ignored, but the known keys still drive a successful post.
    expect(received.path).toBe('/hook/claude')
  })

  it('lets the endpoint file override stale PTY coordinates', async () => {
    const endpoint = writeEndpoint()
    await run(
      {
        ORCA_AGENT_HOOK_ENDPOINT: endpoint,
        ORCA_AGENT_HOOK_PORT: '9',
        ORCA_AGENT_HOOK_TOKEN: 'STALE',
        ORCA_PANE_KEY: 'pane-3'
      },
      '{"y":2}'
    )
    expect(received.path).toBe('/hook/claude')
    expect(received.token).toBe('tok-DEADBEEF-42')
  })

  it('does not post when the port is non-numeric', async () => {
    await run(
      { ORCA_AGENT_HOOK_PORT: '12ab', ORCA_AGENT_HOOK_TOKEN: 't', ORCA_PANE_KEY: 'p' },
      '{"z":3}'
    )
    expect(received.path).toBeUndefined()
  })

  it('does not post when the payload is empty', async () => {
    const endpoint = writeEndpoint()
    await run({ ORCA_AGENT_HOOK_ENDPOINT: endpoint, ORCA_PANE_KEY: 'pane-5' }, '')
    expect(received.path).toBeUndefined()
  })

  it('bypasses a configured http_proxy for the loopback POST', async () => {
    const endpoint = writeEndpoint()
    await run(
      {
        ORCA_AGENT_HOOK_ENDPOINT: endpoint,
        ORCA_PANE_KEY: 'pane-6',
        http_proxy: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:1',
        ALL_PROXY: 'http://127.0.0.1:1'
      },
      '{"p":6}'
    )
    expect(received.path).toBe('/hook/claude')
  })

  it('does not leave the payload temp file behind', async () => {
    const endpoint = writeEndpoint()
    // Pin TMPDIR so the mktemp file lands in our dir and the assertion is exact.
    await run(
      { ORCA_AGENT_HOOK_ENDPOINT: endpoint, ORCA_PANE_KEY: 'pane-7', TMPDIR: dir },
      '{"q":7}'
    )
    const leftovers = readdirSync(dir).filter((n) => n.startsWith('orca-agent-hook.'))
    expect(leftovers).toEqual([])
  })

  // Exercise the Antigravity-shaped options: an extra data field plus a literal
  // fallback when the agent sends no stdin.
  it('substitutes the empty-payload literal and sends extra fields', async () => {
    writeFileSync(
      scriptPath,
      buildPosixManagedHookScript({
        source: 'antigravity',
        extraDataFields: [{ name: 'hook_event_name', envVar: 'ORCA_ANTIGRAVITY_EVENT' }],
        emptyPayload: { literal: '{}' }
      }),
      { mode: 0o755 }
    )
    const endpoint = writeEndpoint()
    await run(
      {
        ORCA_AGENT_HOOK_ENDPOINT: endpoint,
        ORCA_PANE_KEY: 'pane-8',
        ORCA_ANTIGRAVITY_EVENT: 'Stop'
      },
      ''
    )
    expect(received.path).toBe('/hook/antigravity')
    expect(received.payload).toBe('{}')
    expect(received.hookEventName).toBe('Stop')
  })
})
