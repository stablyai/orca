import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import '../unused-default-rpc-methods.test-fixture'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setSecretStore } from '../../../../shared/secret-store'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { USAGE_CREDENTIAL_METHODS } from './usage-credentials'
import { API_KEY_ENVELOPE_PREFIX } from '../../../zcode/zcode-plan-api-key-store'
import { RuntimeAccountController } from '../../runtime-account-controller'
import { agentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { hostAccountsManagedByDesktopMessage } from '../../../../shared/host-account-launch-env'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => home.dir }
})
// Why: the CLI sign-in probe reads platform credential stores this test must not touch.
vi.mock('../../../rate-limits/zcode-usage-fetcher', () => ({
  hasZcodeCliPlanCredentials: () => false
}))

const SECRET = 'sk-test-secret-value-1234'

function createRuntime() {
  const rateLimits = {
    refresh: vi.fn(() => Promise.resolve()),
    invalidateMiniMaxCredentialState: vi.fn(),
    invalidateZcodeCredentialState: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods only read requireUsageRateLimits; the dispatcher only reads getRuntimeId.
  const runtime = {
    getRuntimeId: () => 'runtime-a',
    requireUsageRateLimits: () => rateLimits
  } as unknown as OrcaRuntimeService
  return { runtime, rateLimits }
}

function call(dispatcher: RpcDispatcher, method: string, params?: unknown) {
  const request: RpcRequest = { id: method, authToken: 'token', method, params }
  return dispatcher.dispatch(request)
}

describe('usage credential RPC methods', () => {
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), 'orca-usage-credentials-'))
    // Why plaintext: orcad's sealing is covered elsewhere; this pins where the bytes land.
    setSecretStore({
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('unused')
      },
      decryptString: () => {
        throw new Error('unused')
      },
      describeProtectionGap: () => null
    })
  })

  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true })
  })

  it('saves and clears the MiniMax API key in this host’s ~/.orca and refreshes its usage', async () => {
    const { runtime, rateLimits } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })
    const keyPath = join(home.dir, '.orca', 'minimax-api-key.enc')

    const saved = await call(dispatcher, 'accounts.minimaxSaveApiKey', { apiKey: SECRET })

    expect(saved).toMatchObject({
      ok: true,
      result: { apiKeyConfigured: true, apiKeyProtection: 'plaintext', configured: true }
    })
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    expect(readFileSync(keyPath, 'utf8')).toContain(Buffer.from(SECRET).toString('base64'))
    expect(rateLimits.invalidateMiniMaxCredentialState).toHaveBeenCalledTimes(1)
    expect(rateLimits.refresh).toHaveBeenCalledTimes(1)
    await expect(call(dispatcher, 'accounts.minimaxCredentialsStatus')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: true, cookieConfigured: false }
    })

    await expect(call(dispatcher, 'accounts.minimaxClearApiKey')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: false, apiKeyProtection: null }
    })
    expect(existsSync(keyPath)).toBe(false)
    expect(rateLimits.refresh).toHaveBeenCalledTimes(2)
  })

  it('saves and clears the GLM Coding Plan key on this host', async () => {
    const { runtime, rateLimits } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })

    const saved = await call(dispatcher, 'accounts.zcodePlanSaveApiKey', { apiKey: SECRET })

    expect(saved).toMatchObject({
      ok: true,
      result: { apiKeyConfigured: true, zcodeCliConfigured: false, apiKeyProtection: 'plaintext' }
    })
    expect(JSON.stringify(saved)).not.toContain(SECRET)
    expect(existsSync(join(home.dir, '.orca', 'zcode-plan-api-key.enc'))).toBe(true)
    expect(rateLimits.invalidateZcodeCredentialState).toHaveBeenCalledTimes(1)

    await expect(call(dispatcher, 'accounts.zcodePlanClearApiKey')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: false }
    })
    await expect(call(dispatcher, 'accounts.zcodePlanCredentialsStatus')).resolves.toMatchObject({
      ok: true,
      result: { apiKeyConfigured: false }
    })
  })

  it('refuses a MiniMax session cookie on a host with no browser cookie jar', async () => {
    const { runtime, rateLimits } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })

    const refused = await call(dispatcher, 'accounts.minimaxSaveSessionCookie', { cookie: SECRET })

    expect(refused).toMatchObject({ ok: false })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    expect(existsSync(join(home.dir, '.orca', 'minimax-session-cookie.enc'))).toBe(false)
    expect(rateLimits.refresh).not.toHaveBeenCalled()
    await expect(call(dispatcher, 'accounts.minimaxCredentialsStatus')).resolves.toMatchObject({
      ok: true,
      result: { sessionCookieSupported: false }
    })
  })

  it('rejects an oversized key without echoing it', async () => {
    const { runtime } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })
    const oversized = `${SECRET}${'x'.repeat(5_000)}`

    const refused = await call(dispatcher, 'accounts.minimaxSaveApiKey', { apiKey: oversized })

    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(JSON.stringify(refused)).not.toContain(SECRET)
    expect(existsSync(join(home.dir, '.orca', 'minimax-api-key.enc'))).toBe(false)
  })

  it('rejects a blank key as invalid instead of saving it', async () => {
    const { runtime } = createRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })

    await expect(
      call(dispatcher, 'accounts.zcodePlanSaveApiKey', { apiKey: '   ' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  // Why a tagged cipher: this process opens only what it sealed, as safeStorage and orcad do.
  function useSealingSecretStore(options: { working: boolean }): void {
    const tag = Buffer.from('this-host:')
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (text) => {
        if (!options.working) {
          throw new Error('host key not loaded')
        }
        return Buffer.concat([tag, Buffer.from(text)])
      },
      decryptString: (cipher) => {
        if (!options.working || !cipher.subarray(0, tag.length).equals(tag)) {
          throw new Error('cannot open')
        }
        return cipher.subarray(tag.length).toString()
      },
      describeProtectionGap: () => null
    })
  }

  function writeKeyFile(fileName: string, contents: string): string {
    mkdirSync(join(home.dir, '.orca'), { recursive: true })
    const keyPath = join(home.dir, '.orca', fileName)
    writeFileSync(keyPath, contents)
    return keyPath
  }

  const sealedByOther = (prefix: string): string =>
    `${prefix}encrypted:${Buffer.from('other-app-cipher').toString('base64')}`

  const providers = [
    ['MiniMax', 'minimax-api-key.enc', 'orca-minimax-api-key:v1:', 'minimax'],
    ['GLM', 'zcode-plan-api-key.enc', API_KEY_ENVELOPE_PREFIX, 'zcodePlan']
  ] as const

  it.each(providers)(
    'never overwrites a %s key the other Orca app on this machine sealed, but forgets it',
    async (_provider, fileName, prefix, methodPrefix) => {
      useSealingSecretStore({ working: true })
      const { runtime, rateLimits } = createRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })
      const foreign = sealedByOther(prefix)
      const keyPath = writeKeyFile(fileName, foreign)

      await expect(
        call(dispatcher, `accounts.${methodPrefix}CredentialsStatus`)
      ).resolves.toMatchObject({
        ok: true,
        result: { apiKeyConfigured: true, apiKeyUnreadable: 'sealed-elsewhere' }
      })
      const refused = await call(dispatcher, `accounts.${methodPrefix}SaveApiKey`, {
        apiKey: SECRET
      })
      expect(refused).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('Change it in that app') }
      })
      expect(JSON.stringify(refused)).not.toContain(SECRET)
      expect(readFileSync(keyPath, 'utf8')).toBe(foreign)
      expect(rateLimits.refresh).not.toHaveBeenCalled()

      // Nobody here can read it, so forgetting it loses nothing.
      await expect(call(dispatcher, `accounts.${methodPrefix}ClearApiKey`)).resolves.toMatchObject({
        ok: true,
        result: { apiKeyConfigured: false }
      })
      expect(existsSync(keyPath)).toBe(false)
    }
  )

  it.each(providers)(
    'reports a corrupt %s key as unreadable and lets it be replaced',
    async (_provider, fileName, prefix, methodPrefix) => {
      useSealingSecretStore({ working: true })
      const { runtime } = createRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })
      writeKeyFile(fileName, `${prefix}garbled-without-kind`)

      await expect(
        call(dispatcher, `accounts.${methodPrefix}CredentialsStatus`)
      ).resolves.toMatchObject({ ok: true, result: { apiKeyUnreadable: 'unreadable' } })
      await expect(
        call(dispatcher, `accounts.${methodPrefix}SaveApiKey`, { apiKey: SECRET })
      ).resolves.toMatchObject({ ok: true, result: { apiKeyConfigured: true } })
      await expect(
        call(dispatcher, `accounts.${methodPrefix}CredentialsStatus`)
      ).resolves.toMatchObject({ ok: true, result: { apiKeyUnreadable: undefined } })
    }
  )

  it.each(providers)(
    'does not blame the other app for a sealed %s key while this host cannot decrypt at all',
    async (_provider, fileName, prefix, methodPrefix) => {
      useSealingSecretStore({ working: false })
      const { runtime } = createRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })
      const keyPath = writeKeyFile(fileName, sealedByOther(prefix))

      await expect(
        call(dispatcher, `accounts.${methodPrefix}CredentialsStatus`)
      ).resolves.toMatchObject({ ok: true, result: { apiKeyUnreadable: 'unreadable' } })
      await expect(call(dispatcher, `accounts.${methodPrefix}ClearApiKey`)).resolves.toMatchObject({
        ok: true
      })
      expect(existsSync(keyPath)).toBe(false)
    }
  )

  it('retires catalog source authority when the host restores or receives a changed launch environment', () => {
    const accounts = new RuntimeAccountController()
    const record = agentSessionRecordFixture({ sessionId: 'session-host-environment' })
    const catalog = createAgentModelCatalogService({
      store: agentModelCatalogStore,
      getConversation: () => {
        const held = record
        return held ? agentSessionConversationView(held) : undefined
      },
      getRecord: () => record,
      drivesRecord: () => true,
      resolveAccountHome: async () => record.accountHome,
      probes: {}
    })
    const saved = { wslDistro: 'Ubuntu', claude: {}, terminal: {} }
    try {
      const beforeRestore = catalog.captureSource(record)
      accounts.restoreHostLaunchEnv(saved, () => {})
      expect(beforeRestore()).toBe(false)
      const restored = catalog.captureSource(record)
      accounts.setHostLaunchEnv(saved)
      expect(restored()).toBe(true)
      accounts.setHostLaunchEnv({ ...saved, claude: { CLAUDE_CONFIG_DIR: '/host/new' } })
      expect(restored()).toBe(false)
      expect(catalog.captureSource(record)()).toBe(true)
    } finally {
      catalog.stop()
    }
  })

  it('refuses every call where the desktop owns this host’s accounts, storing nothing', async () => {
    const accounts = new RuntimeAccountController()
    accounts.restoreHostLaunchEnv({ wslDistro: 'Ubuntu', claude: {}, terminal: {} }, () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, backed by a real controller with no account services.
    const runtime = {
      getRuntimeId: () => 'runtime-a',
      requireUsageRateLimits: () => accounts.requireUsageRateLimits()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: [...USAGE_CREDENTIAL_METHODS] })

    for (const [method, params] of [
      ['accounts.zcodePlanSaveApiKey', { apiKey: SECRET }],
      ['accounts.minimaxSaveApiKey', { apiKey: SECRET }],
      ['accounts.minimaxCredentialsStatus', undefined],
      ['accounts.zcodePlanCredentialsStatus', undefined]
    ] as const) {
      await expect(call(dispatcher, method, params)).resolves.toMatchObject({
        ok: false,
        error: { message: hostAccountsManagedByDesktopMessage('Ubuntu') }
      })
    }
    expect(existsSync(join(home.dir, '.orca'))).toBe(false)
  })
})
