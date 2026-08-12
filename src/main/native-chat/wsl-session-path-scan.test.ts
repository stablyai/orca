import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ walk: vi.fn() }))

vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: mocks.walk
}))

import { findWslSessionPath } from './wsl-session-path-scan'

beforeEach(() => {
  mocks.walk.mockReset()
})

describe('WSL session path scans', () => {
  it('matches Claude session names in UNC paths on every host platform', async () => {
    const transcript =
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\-home-ada-repo\\session-id.jsonl'
    mocks.walk.mockImplementation(
      (
        _root: string,
        _agent: string,
        _issues: unknown[],
        options: { filePredicate?: (path: string) => boolean }
      ) => Promise.resolve([transcript].filter((path) => options.filePredicate?.(path)))
    )

    await expect(
      findWslSessionPath(
        'claude',
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects',
        'session-id'
      )
    ).resolves.toBe(transcript)
  })

  it('prunes Claude subagent transcript trees from WSL recovery scans', async () => {
    mocks.walk.mockImplementation(
      (
        _root: string,
        _agent: string,
        _issues: unknown[],
        options: { directoryPredicate?: (name: string, depth: number) => boolean }
      ) => {
        expect(options.directoryPredicate?.('project', 0)).toBe(true)
        expect(options.directoryPredicate?.('session-id', 1)).toBe(true)
        expect(options.directoryPredicate?.('subagents', 2)).toBe(false)
        return Promise.resolve([])
      }
    )

    await expect(findWslSessionPath('claude', 'claude-root', 'session-id')).resolves.toBeNull()
  })

  it('does not prune Codex date hierarchy directories', async () => {
    mocks.walk.mockImplementation(
      (
        _root: string,
        _agent: string,
        _issues: unknown[],
        options: { directoryPredicate?: (name: string, depth: number) => boolean }
      ) => {
        expect(options.directoryPredicate?.('subagents', 3)).toBe(true)
        return Promise.resolve([])
      }
    )

    await expect(findWslSessionPath('codex', 'codex-root', 'session-id')).resolves.toBeNull()
  })
})
