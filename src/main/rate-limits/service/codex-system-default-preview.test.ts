import { expect, it, vi } from 'vitest'
import { RateLimitService } from './rate-limit-service'
import { fetchCodexRateLimits } from '../providers/codex/codex-fetcher'
import { codexSystemDefaultUsagePreview } from '../providers/codex/codex-system-default-usage-preview'
import type { CodexSystemDefaultIdentity } from '../../../shared/agent-accounts/managed-account-types'

vi.mock('../providers/codex/codex-fetcher', () => ({ fetchCodexRateLimits: vi.fn() }))

it('reads System default without selecting it and discards usage when its login identity changes', async () => {
  let identity: CodexSystemDefaultIdentity = {
    hasAuth: true,
    authKind: 'oauth',
    email: 'personal@example.test',
    providerAccountId: 'personal',
    workspaceLabel: null
  }
  const service = new RateLimitService()
  service.setInactiveCodexAccountsResolver(() => {
    const preview = codexSystemDefaultUsagePreview('managed-work', identity, '/system/.codex')
    return preview ? [preview] : []
  })
  vi.mocked(fetchCodexRateLimits).mockResolvedValue({
    provider: 'codex',
    status: 'ok',
    error: null,
    updatedAt: 1_700_000_000_000,
    session: { usedPercent: 17, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null
  })
  await service.fetchInactiveCodexAccountsOnOpen()
  expect(fetchCodexRateLimits).toHaveBeenCalledWith(
    expect.objectContaining({ codexHomePath: '/system/.codex' })
  )
  expect(service.getState().codex).toBeNull()
  expect(service.getState().inactiveCodexAccounts[0]?.rateLimits?.session?.usedPercent).toBe(17)
  identity = { ...identity, email: 'other@example.test', providerAccountId: 'other' }
  expect(service.getState().inactiveCodexAccounts).toEqual([])
})

it('does not preview signed-out, API-key or already-selected System default as another account', () => {
  const identity: CodexSystemDefaultIdentity = {
    hasAuth: true,
    authKind: 'oauth',
    email: 'personal@example.test',
    providerAccountId: 'personal',
    workspaceLabel: null
  }
  expect(codexSystemDefaultUsagePreview(null, identity, '/system/.codex')).toBeNull()
  expect(
    codexSystemDefaultUsagePreview('work', { ...identity, authKind: 'api-key' }, '/system/.codex')
  ).toBeNull()
  expect(
    codexSystemDefaultUsagePreview('work', { ...identity, hasAuth: false }, '/system/.codex')
  ).toBeNull()
})
