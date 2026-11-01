import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import {
  canonicalizeAgentSessionIdentity,
  createEphemeralAgentSessionClaimSigner,
  loadAgentSessionClaimSigner,
  type AgentSessionClaimSigner
} from '../runtime/agent-session/ownership/agent-session-claim-identity'

const namespace = { machine: 'm', principal: 'u', container: 'native', providerRoot: 'default' }
const identity = canonicalizeAgentSessionIdentity('claude', { key: 'session_id', id: 'conv-1' })
const surface = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '12345678-1234-4234-8234-123456789abc',
  terminalHandle: 'term_handle'
}

async function ensureFrom(
  daemonOwners: ClaimedAgentPtyOwnerRegistry,
  signer: AgentSessionClaimSigner,
  ptyId: string
) {
  return await daemonOwners.ensure({
    claim: signer.createClaim({ namespace, identity, canonicalWorktreeId: 'worktree' }),
    surface,
    spawn: async () => ({ ptyId }),
    isLive: () => true
  })
}

describe('orcad agent-session claim signer', () => {
  it('adopts the live PTY after an orcad restart instead of starting a second writer', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orcad-claim-signer-'))
    try {
      const daemonOwners = new ClaimedAgentPtyOwnerRegistry()
      const first = await ensureFrom(
        daemonOwners,
        loadAgentSessionClaimSigner(userData, userData),
        'pty-1'
      )
      const restarted = await ensureFrom(
        daemonOwners,
        loadAgentSessionClaimSigner(userData, userData),
        'pty-2'
      )
      expect(first.disposition).toBe('created')
      expect(restarted).toMatchObject({ disposition: 'adopted', owner: { ptyId: 'pty-1' } })
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('a per-process signer cannot recognise the previous incarnation (the old orcad default)', async () => {
    const daemonOwners = new ClaimedAgentPtyOwnerRegistry()
    await ensureFrom(daemonOwners, createEphemeralAgentSessionClaimSigner('runtime-a'), 'pty-1')
    const restarted = await ensureFrom(
      daemonOwners,
      createEphemeralAgentSessionClaimSigner('runtime-b'),
      'pty-2'
    )
    expect(restarted).toMatchObject({ disposition: 'created', owner: { ptyId: 'pty-2' } })
  })
})
