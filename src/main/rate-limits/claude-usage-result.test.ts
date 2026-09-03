import { describe, expect, it } from 'vitest'
import { CLAUDE_MANAGED_KEYCHAIN_UNAVAILABLE_PROVENANCE } from '../claude-accounts/runtime-auth/runtime-auth-types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { metadataForClaudeUsageAttempt } from './claude-usage-result'
import type { ClaudeOAuthCredentialReadResult } from './claude-oauth-credentials'

const credentials: ClaudeOAuthCredentialReadResult = {
  token: null,
  hasRefreshableCredentials: false,
  source: 'none'
}

const degradedPreparation: ClaudeRuntimeAuthPreparation = {
  configDir: '/Users/test/.claude',
  envPatch: {},
  stripAuthEnv: false,
  provenance: CLAUDE_MANAGED_KEYCHAIN_UNAVAILABLE_PROVENANCE
}

describe('metadataForClaudeUsageAttempt', () => {
  it('classifies a managed-keychain launch fallback for the renderer', () => {
    expect(
      metadataForClaudeUsageAttempt({
        attemptedSources: [],
        oauthCredentials: credentials,
        authPreparation: degradedPreparation,
        failureKind: 'missing-credentials'
      })
    ).toMatchObject({
      failureKind: 'managed-keychain-unavailable',
      authProvenance: CLAUDE_MANAGED_KEYCHAIN_UNAVAILABLE_PROVENANCE
    })
  })
})
