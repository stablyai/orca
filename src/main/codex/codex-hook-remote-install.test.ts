import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'smol-toml'
import type { SFTPWrapper } from 'ssh2'

const remote = vi.hoisted(() => {
  const hooksJson: { hooks: Record<string, unknown> } = { hooks: {} }
  return { files: new Map<string, string>(), hooksJson }
})

vi.mock('../agent-hooks/installer-utils-remote', () => ({
  readHooksJsonRemote: vi.fn(async () => remote.hooksJson),
  writeHooksJsonRemote: vi.fn(async () => undefined),
  writeManagedScriptRemote: vi.fn(async () => undefined),
  readTextFileRemote: vi.fn(async (_sftp: unknown, path: string) => remote.files.get(path) ?? null),
  writeTextFileRemoteAtomic: vi.fn(async (_sftp: unknown, path: string, content: string) => {
    remote.files.set(path, content)
  })
}))

const { installCodexHooksRemote } = await import('./codex-hook-remote-install')
const { readTomlValueAtPath } = await import('./codex-config-toml-document')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every SFTP call is mocked above, so the handle is never used.
const sftp = {} as SFTPWrapper
const tomlPath = '/home/u/.codex/config.toml'

describe('installCodexHooksRemote', () => {
  beforeEach(() => {
    remote.files.clear()
    remote.hooksJson = { hooks: {} }
  })

  it('turns Orca’s own entries on, even over a stale `enabled = false` at that position (#23289)', async () => {
    const staleKey = '/home/u/.codex/hooks.json:session_start:0:0'
    remote.files.set(
      tomlPath,
      [
        `[hooks.state."${staleKey}"]`,
        'enabled = false',
        'trusted_hash = "sha256:old"',
        '',
        '[hooks.state."/repo/.codex/hooks.json:stop:0:0"]',
        'enabled = false',
        ''
      ].join('\n')
    )

    const status = await installCodexHooksRemote(sftp, '/home/u')

    expect(status.state).toBe('installed')
    const state = readTomlValueAtPath(parse(remote.files.get(tomlPath) ?? ''), ['hooks', 'state'])
    expect(state).toMatchObject({
      [staleKey]: { enabled: true },
      '/home/u/.codex/hooks.json:stop:0:0': { enabled: true },
      // A project hook's review state is the user's decision.
      '/repo/.codex/hooks.json:stop:0:0': { enabled: false }
    })
    expect(
      readTomlValueAtPath(parse(remote.files.get(tomlPath) ?? ''), [
        'hooks',
        'state',
        '/repo/.codex/hooks.json:stop:0:0'
      ])
    ).toEqual({ enabled: false })
  })
})
