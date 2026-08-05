import { describe, expect, it, vi } from 'vitest'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import { resolveMobileCursorCommand } from './mobile-cursor-command'

describe('resolveMobileCursorCommand', () => {
  it('preserves the host-matched Cursor command', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        version: 1,
        agents: ['cursor'],
        matchedCommands: { cursor: 'cursor agent' }
      }
    })

    await expect(resolveMobileCursorCommand({ client: { sendRequest } })).resolves.toBe(
      'cursor agent'
    )
    expect(sendRequest).toHaveBeenCalledWith('preflight.detectAgentInventory', undefined, {
      timeoutMs: RESUME_RPC_TIMEOUT_MS
    })
  })

  it('fails closed without a valid inventory unless an override exists', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ ok: false })
    await expect(resolveMobileCursorCommand({ client: { sendRequest } })).resolves.toBeNull()
    sendRequest.mockRejectedValueOnce(new Error('offline'))
    await expect(
      resolveMobileCursorCommand({
        client: { sendRequest },
        settings: { agentCmdOverrides: { cursor: 'cursor-dev' } }
      })
    ).resolves.toBe('cursor-dev')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('requests inventory from the exact WSL distro context', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        version: 1,
        agents: ['cursor'],
        matchedCommands: { cursor: 'cursor agent' }
      }
    })

    await expect(
      resolveMobileCursorCommand({
        client: { sendRequest },
        wslDistro: ' Ubuntu '
      })
    ).resolves.toBe('cursor agent')
    expect(sendRequest).toHaveBeenCalledWith(
      'preflight.detectAgentInventory',
      { wslDistro: 'Ubuntu' },
      { timeoutMs: RESUME_RPC_TIMEOUT_MS }
    )
  })
})
