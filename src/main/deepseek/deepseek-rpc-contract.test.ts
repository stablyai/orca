import { describe, expect, it } from 'vitest'
import { DEEPSEEK_ACCOUNT_METHODS } from '../runtime/rpc/methods/accounts-deepseek'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist'
import {
  SaveDeepSeekApiKeyParams,
  DeepSeekAccountOwnerParams
} from '../../shared/rpc-contract/deepseek-account-params'
import { redactValue } from '../observability/redactor'
import { RuntimeAccountController } from '../runtime/runtime-account-controller'
import { unsupportedDeepSeekAccount } from '../../shared/deepseek-balance'

describe('DeepSeek credential RPC boundaries', () => {
  it('returns explicit unsupported when account services are absent on the owning host', () => {
    expect(new RuntimeAccountController().getDeepSeekAccountStatus()).toEqual(
      unsupportedDeepSeekAccount()
    )
  })
  it('publishes presence, save, remove and refresh but no credential-read method', () => {
    expect(DEEPSEEK_ACCOUNT_METHODS.map((method) => method.name)).toEqual([
      'accounts.deepSeekStatus',
      'accounts.saveDeepSeekApiKey',
      'accounts.removeDeepSeekApiKey',
      'accounts.refreshDeepSeek'
    ])
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('accounts.deepSeekStatus')).toBe(true)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('accounts.refreshDeepSeek')).toBe(true)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('accounts.saveDeepSeekApiKey')).toBe(false)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('accounts.removeDeepSeekApiKey')).toBe(false)
  })
  it('requires a captured owner and restricts key input to the save request', () => {
    expect(SaveDeepSeekApiKeyParams.safeParse({ apiKey: 'synthetic' }).success).toBe(false)
    expect(
      DeepSeekAccountOwnerParams.safeParse({ ownerId: 'host', apiKey: 'synthetic' }).success
    ).toBe(false)
    expect(SaveDeepSeekApiKeyParams.parse({ ownerId: 'host', apiKey: ' synthetic ' })).toEqual({
      ownerId: 'host',
      apiKey: 'synthetic'
    })
  })
  it('reuses secret-field redaction for credential save diagnostics', () => {
    const redacted = redactValue({
      method: 'accounts.saveDeepSeekApiKey',
      params: { ownerId: 'host', apiKey: 'synthetic-secret' }
    })
    expect(JSON.stringify(redacted)).not.toContain('synthetic-secret')
    expect(JSON.stringify(redacted)).toContain('host')
  })
})
