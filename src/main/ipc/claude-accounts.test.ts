import { describe, expect, it, vi, beforeEach } from 'vitest'

import { registerClaudeAccountHandlers } from './claude-accounts'

// Why: T18 — the refresh-preset-defaults handler delegates to
// `clearPresetRegistryCache` + `fetchPresetRegistry`. We mock the module so
// tests run without touching disk or network.
vi.mock('../claude-accounts/preset-registry', () => ({
  clearPresetRegistryCache: vi.fn(async () => undefined),
  fetchPresetRegistry: vi.fn(async () => ({ version: 1, presets: {} }))
}))

// Why: cover the claudeAccounts:add IPC handler — it must accept an optional
// polymorphic AddClaudeAccountInput and pass it straight through to
// ClaudeAccountService.addAccount. The legacy no-arg OAuth path must continue
// to work for callers that haven't migrated yet.

const handleHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler)
    }
  }
}))

beforeEach(() => {
  handleHandlers.clear()
})

function makeServiceStub(): {
  service: Parameters<typeof registerClaudeAccountHandlers>[0]
  addAccount: ReturnType<typeof vi.fn>
  validateAccount: ReturnType<typeof vi.fn>
  setWorkspaceOverride: ReturnType<typeof vi.fn>
  clearWorkspaceOverride: ReturnType<typeof vi.fn>
  validateInput: ReturnType<typeof vi.fn>
} {
  const addAccount = vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null })
  const validateAccount = vi.fn().mockResolvedValue({ ok: true })
  const setWorkspaceOverride = vi.fn().mockResolvedValue(undefined)
  const clearWorkspaceOverride = vi.fn().mockResolvedValue(undefined)
  const validateInput = vi.fn().mockResolvedValue({ ok: true })
  const service = {
    listAccounts: vi.fn(),
    addAccount,
    reauthenticateAccount: vi.fn(),
    removeAccount: vi.fn(),
    selectAccount: vi.fn(),
    validateAccount,
    setWorkspaceOverride,
    clearWorkspaceOverride,
    validateInput
  } as unknown as Parameters<typeof registerClaudeAccountHandlers>[0]
  return {
    service,
    addAccount,
    validateAccount,
    setWorkspaceOverride,
    clearWorkspaceOverride,
    validateInput
  }
}

describe('claudeAccounts:add IPC', () => {
  it('forwards no input to addAccount when called with undefined (legacy OAuth path)', async () => {
    const { service, addAccount } = makeServiceStub()
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:add')
    expect(handler).toBeDefined()

    await handler!({}, undefined)

    expect(addAccount).toHaveBeenCalledTimes(1)
    expect(addAccount).toHaveBeenCalledWith(undefined)
  })

  it('forwards a polymorphic anthropic-api-key input to addAccount', async () => {
    const { service, addAccount } = makeServiceStub()
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:add')!
    const input = {
      authMethod: 'anthropic-api-key' as const,
      label: 'work',
      secretFromUser: 'sk-ant-xxx'
    }

    await handler({}, input)

    expect(addAccount).toHaveBeenCalledWith(input)
  })

  it('forwards a polymorphic anthropic-compat input to addAccount', async () => {
    const { service, addAccount } = makeServiceStub()
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:add')!
    const input = {
      authMethod: 'anthropic-compat' as const,
      label: 'zai',
      secretFromUser: 'token-123',
      providerConfig: { preset: 'zai' as const }
    }

    await handler({}, input)

    expect(addAccount).toHaveBeenCalledWith(input)
  })
})

describe('claudeAccounts:validate IPC', () => {
  it('forwards the accountId to service.validateAccount and returns its result', async () => {
    const { service, validateAccount } = makeServiceStub()
    validateAccount.mockResolvedValueOnce({ ok: true })
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:validate')
    expect(handler).toBeDefined()

    const result = await handler!({}, { accountId: 'a1' })

    expect(validateAccount).toHaveBeenCalledWith('a1')
    expect(result).toEqual({ ok: true })
  })

  it('returns "Account not found." when the service throws', async () => {
    const { service, validateAccount } = makeServiceStub()
    validateAccount.mockRejectedValueOnce(new Error('That Claude account no longer exists.'))
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:validate')!
    const result = await handler({}, { accountId: 'missing' })

    expect(result).toEqual({ ok: false, reason: 'Account not found.' })
  })

  it('forwards a failure ValidationResult through verbatim', async () => {
    const { service, validateAccount } = makeServiceStub()
    validateAccount.mockResolvedValueOnce({
      ok: false,
      reason: 'API key invalid or revoked.',
      rescueHint: 'Generate a new key in the Anthropic Console and try again.'
    })
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:validate')!
    const result = await handler({}, { accountId: 'a1' })
    expect(result).toEqual({
      ok: false,
      reason: 'API key invalid or revoked.',
      rescueHint: 'Generate a new key in the Anthropic Console and try again.'
    })
  })
})

// P2 T19 — per-worktree override + Detect/Validate probe IPC.
describe('claudeAccounts workspace override + validateInput IPC (P2)', () => {
  it('claudeAccounts:setWorkspaceOverride forwards to service', async () => {
    const { service, setWorkspaceOverride } = makeServiceStub()
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:setWorkspaceOverride')!
    await handler({}, { worktreeId: 'r::/wt1', accountId: 'a' })
    expect(setWorkspaceOverride).toHaveBeenCalledWith({ worktreeId: 'r::/wt1', accountId: 'a' })
  })

  it('claudeAccounts:clearWorkspaceOverride forwards to service', async () => {
    const { service, clearWorkspaceOverride } = makeServiceStub()
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:clearWorkspaceOverride')!
    await handler({}, { worktreeId: 'r::/wt1' })
    expect(clearWorkspaceOverride).toHaveBeenCalledWith({ worktreeId: 'r::/wt1' })
  })

  it('claudeAccounts:validateInput forwards the polymorphic input to service', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockResolvedValueOnce({ ok: true })
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:validateInput')!
    const input = {
      authMethod: 'anthropic-api-key' as const,
      label: 'probe',
      secretFromUser: 'sk-ant-xxx'
    }
    const result = await handler({}, input)
    expect(validateInput).toHaveBeenCalledWith(input)
    expect(result).toEqual({ ok: true })
  })

  it('claudeAccounts:validateInput converts thrown errors into a failure ValidationResult', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockRejectedValueOnce(new Error('Provider preset is required.'))
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:validateInput')!
    const result = await handler({}, { authMethod: 'anthropic-compat', secretFromUser: 't' })
    expect(result).toEqual({ ok: false, reason: 'Provider preset is required.' })
  })
})

// P3 T18 — dedicated Bedrock/Vertex detect probes + preset-defaults refresh.
describe('claudeAccounts:bedrock-detect IPC (P3)', () => {
  it('forwards a Bedrock probe payload to service.validateInput', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockResolvedValueOnce({ ok: true })
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:bedrock-detect')!
    const result = await handler({}, { region: 'us-east-1', secret: 'bearer-xyz' })

    expect(validateInput).toHaveBeenCalledWith({
      authMethod: 'aws-bedrock',
      secretFromUser: 'bearer-xyz',
      providerConfig: { region: 'us-east-1' }
    })
    expect(result).toEqual({ ok: true })
  })

  it('IAM-chain probe omits secretFromUser when secret is empty', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockResolvedValueOnce({ ok: true })
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:bedrock-detect')!
    await handler({}, { region: 'eu-west-1', secret: '' })

    const call = validateInput.mock.calls[0][0] as {
      authMethod: string
      secretFromUser?: string
    }
    expect(call.authMethod).toBe('aws-bedrock')
    expect('secretFromUser' in call).toBe(false)
  })

  it('forwards inferenceProfilePrefix when present', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockResolvedValueOnce({ ok: true })
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:bedrock-detect')!
    await handler({}, {
      region: 'eu-west-1',
      secret: 'bearer',
      inferenceProfilePrefix: 'eu.'
    })
    expect(validateInput).toHaveBeenCalledWith({
      authMethod: 'aws-bedrock',
      secretFromUser: 'bearer',
      providerConfig: { region: 'eu-west-1', inferenceProfilePrefix: 'eu.' }
    })
  })

  it('converts a thrown service error into a failure ValidationResult', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockRejectedValueOnce(new Error('Bedrock region invalid.'))
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:bedrock-detect')!
    const result = await handler({}, { region: 'bad', secret: '' })
    expect(result).toEqual({ ok: false, reason: 'Bedrock region invalid.' })
  })
})

describe('claudeAccounts:vertex-detect IPC (P3)', () => {
  it('forwards a Vertex probe payload to service.validateInput', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockResolvedValueOnce({ ok: true })
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:vertex-detect')!
    const result = await handler({}, { projectId: 'my-gcp', region: 'us-east5' })

    expect(validateInput).toHaveBeenCalledWith({
      authMethod: 'google-vertex',
      providerConfig: { projectId: 'my-gcp', region: 'us-east5' }
    })
    expect(result).toEqual({ ok: true })
  })

  it('converts a thrown service error into a failure ValidationResult', async () => {
    const { service, validateInput } = makeServiceStub()
    validateInput.mockRejectedValueOnce(new Error('gcloud ADC not found.'))
    registerClaudeAccountHandlers(service)
    const handler = handleHandlers.get('claudeAccounts:vertex-detect')!
    const result = await handler({}, { projectId: 'p', region: 'us-east5' })
    expect(result).toEqual({ ok: false, reason: 'gcloud ADC not found.' })
  })
})

describe('claudeAccounts:refresh-preset-defaults IPC (P3)', () => {
  it('clears the cache then refetches and returns the registry', async () => {
    const { service } = makeServiceStub()
    registerClaudeAccountHandlers(service)
    const presetRegistry = await import('../claude-accounts/preset-registry')
    const clearMock = vi.mocked(presetRegistry.clearPresetRegistryCache)
    const fetchMock = vi.mocked(presetRegistry.fetchPresetRegistry)
    clearMock.mockClear()
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce({
      version: 1,
      presets: { zai: { opus: 'glm-opus-2' } }
    })

    const handler = handleHandlers.get('claudeAccounts:refresh-preset-defaults')!
    const result = (await handler({})) as { fetchedAt: number; registry: unknown }

    // Order matters: cache must be invalidated before the refetch so the new
    // result reflects the upstream truth instead of stale TTL data.
    expect(clearMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(clearMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]
    )
    expect(result.registry).toEqual({
      version: 1,
      presets: { zai: { opus: 'glm-opus-2' } }
    })
    expect(typeof result.fetchedAt).toBe('number')
  })

  it('returns a null registry when the fetch falls back to null (offline + no cache)', async () => {
    const { service } = makeServiceStub()
    registerClaudeAccountHandlers(service)
    const presetRegistry = await import('../claude-accounts/preset-registry')
    const fetchMock = vi.mocked(presetRegistry.fetchPresetRegistry)
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(null)

    const handler = handleHandlers.get('claudeAccounts:refresh-preset-defaults')!
    const result = (await handler({})) as { fetchedAt: number | null; registry: unknown }
    expect(result.registry).toBeNull()
    expect(result.fetchedAt).toBeNull()
  })
})
