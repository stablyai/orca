import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { OpenCodeHookService, _internals } from './hook-service'

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

describe('OpenCodeHookService buildPtyEnv / clearPty round-trip', () => {
  // Why: the primitives above only prove the helpers work in isolation. This
  // suite exercises the public surface against a real filesystem so a future
  // regression — e.g. re-tightening the id guard or desyncing the path used by
  // writePluginConfig vs clearPty — fails loudly. Before #1148 the service
  // silently returned {} for daemon-shaped ids; these tests lock that in.
  const daemonSessionId =
    '50c010a2-bc8e-4eb1-8847-5812133ad6df::/Users/thebr/ghostx/workspaces/noqa/autoheal@@a1b2c3d4'
  const plainUuidId = 'c0ffee00-0000-4000-8000-000000000000'
  let userDataDir: string

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-opencode-hooks-'))
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  afterEach(() => {
    const hooksRoot = join(userDataDir, 'opencode-hooks')
    rmSync(hooksRoot, { recursive: true, force: true })
  })

  it('writes OPENCODE_CONFIG_DIR for a daemon-shaped sessionId and installs the plugin file', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(daemonSessionId)

    expect(env.OPENCODE_CONFIG_DIR).toBeTruthy()
    expect(env.OPENCODE_CONFIG_DIR).toBe(
      join(userDataDir, 'opencode-hooks', toSafeDirName(daemonSessionId))
    )

    const pluginPath = join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js')
    expect(existsSync(pluginPath)).toBe(true)
    // Sanity-check the file has plugin source, not a stray write.
    expect(readFileSync(pluginPath, 'utf8')).toContain('OrcaOpenCodeStatusPlugin')
  })

  it('clearPty removes the same directory buildPtyEnv created', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(daemonSessionId)
    const configDir = env.OPENCODE_CONFIG_DIR!
    expect(existsSync(configDir)).toBe(true)

    service.clearPty(daemonSessionId)
    expect(existsSync(configDir)).toBe(false)
  })

  it('buildPtyEnv returns {} for an unusable id and creates nothing on disk', () => {
    const service = new OpenCodeHookService()
    const hooksRoot = join(userDataDir, 'opencode-hooks')

    expect(service.buildPtyEnv('')).toEqual({})
    expect(existsSync(hooksRoot)).toBe(false)
  })

  it('works end-to-end for a plain UUID id (non-daemon path)', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(plainUuidId)

    expect(env.OPENCODE_CONFIG_DIR).toBe(
      join(userDataDir, 'opencode-hooks', toSafeDirName(plainUuidId))
    )
    expect(existsSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'))).toBe(
      true
    )

    service.clearPty(plainUuidId)
    expect(existsSync(env.OPENCODE_CONFIG_DIR!)).toBe(false)
  })
})
