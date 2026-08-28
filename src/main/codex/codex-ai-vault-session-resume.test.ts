import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'
import { prepareCodexAiVaultSessionResume } from './codex-ai-vault-session-resume'

describe('prepareCodexAiVaultSessionResume', () => {
  let root: string
  let peerHome: string
  let selectedHome: string
  let peerRolloutPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-ai-vault-resume-'))
    peerHome = join(root, 'codex-accounts', 'account-a', 'home')
    selectedHome = join(root, 'codex-accounts', 'account-b', 'home')
    const relativeRolloutPath = join(
      'sessions',
      '2026',
      '08',
      '17',
      'rollout-2026-08-17T10-00-00-session.jsonl'
    )
    peerRolloutPath = join(peerHome, relativeRolloutPath)
    const selectedRolloutPath = join(selectedHome, relativeRolloutPath)
    mkdirSync(dirname(peerRolloutPath), { recursive: true })
    mkdirSync(dirname(selectedRolloutPath), { recursive: true })
    writeFileSync(peerRolloutPath, '{"type":"session_meta"}\n', 'utf-8')
    linkSync(peerRolloutPath, selectedRolloutPath)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses before falling through when selected-home trust is indeterminate', async () => {
    const resolveSelectedHome = vi.fn((): string | null => {
      throw new ManagedCodexHomeTemporarilyUnavailableError()
    })
    const isSystemDefaultRealHome = vi.fn(() => true)

    await expect(prepare(resolveSelectedHome, isSystemDefaultRealHome)).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    expect(resolveSelectedHome).toHaveBeenCalledOnce()
    expect(isSystemDefaultRealHome).not.toHaveBeenCalled()
  })

  it('repins an aliased rollout when the selected home is owned', async () => {
    await expect(prepare(() => selectedHome)).resolves.toEqual({
      useRealCodexHome: false,
      substituteCodexHome: selectedHome
    })
  })

  it('preserves deliberate no-selection behavior for a proven-untrusted home', async () => {
    await expect(prepare(() => null)).resolves.toEqual({ useRealCodexHome: false })
  })

  function prepare(
    resolveSelectedHome: () => string | null,
    isSystemDefaultRealHome: () => boolean = () => false
  ) {
    return prepareCodexAiVaultSessionResume(
      {
        agent: 'codex',
        filePath: peerRolloutPath,
        codexHome: peerHome,
        executionHostId: 'local'
      },
      {
        runtimeHome: {
          isHostSystemDefaultRealHome: isSystemDefaultRealHome,
          resolveSelectedHostAccountCodexHomePathForResume: resolveSelectedHome
        },
        systemCodexHomePath: join(root, 'system-codex-home')
      }
    )
  }
})
