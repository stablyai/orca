import type {
  MobileWebSourceControlRepositoryState,
  MobileWebSourceControlUpstreamSnapshot
} from '../../../src/shared/mobile-web/source-control-sync-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export function assertMobileWebRepositoryIdentity(
  state: Pick<MobileWebSourceControlRepositoryState, 'head' | 'branch'>,
  expected: { expectedHead: string | null; expectedBranch: string | null }
): void {
  if (state.head !== expected.expectedHead || state.branch !== expected.expectedBranch) {
    throw new MobileWebBrokerError('conflict')
  }
}

export function assertMobileWebExpectedUpstream(
  state: MobileWebSourceControlRepositoryState,
  expected: MobileWebSourceControlUpstreamSnapshot
): void {
  if (
    state.upstream.hasUpstream !== expected.hasUpstream ||
    state.upstream.upstreamName !== expected.upstreamName ||
    state.upstream.ahead !== expected.ahead ||
    state.upstream.behind !== expected.behind ||
    state.upstream.hasConfiguredPushTarget !== expected.hasConfiguredPushTarget ||
    state.upstream.behindCommitsArePatchEquivalent !== expected.behindCommitsArePatchEquivalent
  ) {
    throw new MobileWebBrokerError('conflict')
  }
}

export function assertMobileWebNoConflictOperation(
  state: Pick<MobileWebSourceControlRepositoryState, 'conflictOperation'>
): void {
  if (state.conflictOperation !== 'unknown') {
    throw new MobileWebBrokerError('conflict')
  }
}
