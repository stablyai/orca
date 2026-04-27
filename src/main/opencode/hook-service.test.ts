import { describe, expect, it } from 'vitest'
import { _internals } from './hook-service'

const { isUsableId, toSafeDirName } = _internals

describe('OpenCode hook plugin source', () => {
  it('filters child sessions via parentID lookup before forwarding events', () => {
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('async function isChildSession(client, sessionID)')
    expect(source).toContain('const sessions = await client.session.list();')
    expect(source).toContain('const isChild = !!session?.parentID;')
    expect(source).toContain('if (sessionID && (await isChildSession(client, sessionID))) {')
    expect(source).toContain('return true;')
  })

  it('still accepts an optional opaque plugin context instead of destructuring', () => {
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('export const OrcaOpenCodeStatusPlugin = async (_ctx) => {')
    expect(source).toContain('const client = _ctx?.client;')
  })

  it('resolves hook coords from the endpoint file before falling back to process.env', () => {
    // Why: a long-running OpenCode session was fork()ed with the prior Orca's
    // PORT/TOKEN frozen into process.env. The plugin must prefer the on-disk
    // endpoint file (rewritten on every Orca start()) over env, otherwise it
    // keeps posting to a dead port after an Orca restart.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('function readEndpointFile()')
    expect(source).toContain('process.env.ORCA_AGENT_HOOK_ENDPOINT')
    // Parser accepts both `KEY=VALUE` (Unix) and `set KEY=VALUE` (Windows):
    expect(source).toContain('/^(?:set\\s+)?([A-Z_]+)=(.*)$/')
    expect(source).toContain('function resolveHookCoords()')
    // File takes precedence over env — the whole point of v2:
    expect(source).toContain(
      'port: fileEnv.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT'
    )
    expect(source).toContain(
      'token: fileEnv.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN'
    )
    // post() uses the resolved coords, not a cached-at-startup url:
    expect(source).toContain('const coords = resolveHookCoords();')
    expect(source).toContain('`http://127.0.0.1:${coords.port}/hook/opencode`')
    expect(source).toContain('"X-Orca-Agent-Hook-Token": coords.token')
  })

  it('guards endpoint-file parse warnings with a process-lifetime latch', () => {
    // Why: ENOENT is the normal pre-install case and must stay silent, but a
    // malformed/unreadable file (EACCES, EIO, parse error) would otherwise
    // spam stderr once per hook post. The latch keeps the warning to once per
    // OpenCode process — mirrors server.ts's warnedVersions/warnedEnvs intent.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('let warnedBadEndpoint = false;')
    expect(source).toContain('err.code !== "ENOENT"')
    expect(source).toContain('warnedBadEndpoint = true;')
  })
})

describe('OpenCode id safety guard', () => {
  it('accepts the daemon-path sessionId shape (worktreeId@@uuid with ::/...)', () => {
    // Why: after the daemon-parity refactor (#1148) pty.ts mints sessionIds
    // like `<worktreeId>@@<uuid>` where worktreeId contains "::" and a
    // filesystem path. The previous strict regex rejected every real id and
    // silently dropped OPENCODE_CONFIG_DIR. Lock in that such ids are now
    // accepted so the plugin dir is actually written.
    const daemonSessionId =
      '50c010a2-bc8e-4eb1-8847-5812133ad6df::/Users/thebr/ghostx/workspaces/noqa/autoheal@@a1b2c3d4'
    expect(isUsableId(daemonSessionId)).toBe(true)
  })

  it('accepts ids at the inclusive upper length bound', () => {
    expect(isUsableId('x'.repeat(1024))).toBe(true)
  })

  it('rejects empty or oversized ids', () => {
    expect(isUsableId('')).toBe(false)
    expect(isUsableId('x'.repeat(1025))).toBe(false)
  })

  it('rejects non-string runtime values even though the type says string', () => {
    // Why: the typeof guard is defense-in-depth for any-typed callers;
    // without a test, a future refactor could delete the guard silently.
    expect(isUsableId(undefined as unknown as string)).toBe(false)
    expect(isUsableId(null as unknown as string)).toBe(false)
    expect(isUsableId(42 as unknown as string)).toBe(false)
  })

  it('derives a filesystem-safe directory name independent of the raw id', () => {
    const name = toSafeDirName('50c010::/Users/thebr/x/y@@uuid')
    // Pure hex, bounded length — no slashes, colons, or caller content.
    expect(name).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable across calls for the same id', () => {
    const id = 'some-session-id'
    expect(toSafeDirName(id)).toBe(toSafeDirName(id))
  })

  it('produces different names for different ids', () => {
    expect(toSafeDirName('a')).not.toBe(toSafeDirName('b'))
  })
})
