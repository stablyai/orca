import { describe, expect, it, vi } from 'vitest'
import { prepareCodexResumeHome } from './codex-resume'

const SESSION = { key: 'session_id' as const, id: 'abc' }

describe('prepareCodexResumeHome for a kept conversation', () => {
  it('asks for the kept account and drops the selected-account restart target', async () => {
    const prepare = vi.fn(async () => null)
    prepareCodexResumeHome(prepare, {
      launchAgent: 'codex',
      providerSession: SESSION,
      target: { runtime: 'host' },
      useSelectedAccount: true,
      keptAccount: { accountId: 'account-a' }
    })
    expect(prepare).toHaveBeenCalledWith({
      providerSession: SESSION,
      target: { runtime: 'host' },
      launchEnv: undefined,
      keptAccount: { accountId: 'account-a' }
    })
  })

  it('passes a System default keep through as null', () => {
    const prepare = vi.fn(async () => null)
    prepareCodexResumeHome(prepare, {
      launchAgent: 'codex',
      providerSession: SESSION,
      target: { runtime: 'host' },
      keptAccount: { accountId: null }
    })
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ keptAccount: { accountId: null } })
    )
  })

  it('keeps the selected-account restart target for a conversation nobody kept', () => {
    const prepare = vi.fn(async () => null)
    prepareCodexResumeHome(prepare, {
      launchAgent: 'codex',
      providerSession: SESSION,
      target: { runtime: 'host' },
      useSelectedAccount: true
    })
    expect(prepare).toHaveBeenCalledWith({
      providerSession: SESSION,
      target: { runtime: 'host' },
      launchEnv: undefined,
      useSelectedAccount: true
    })
  })
})
