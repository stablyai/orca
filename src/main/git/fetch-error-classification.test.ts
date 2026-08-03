import { describe, expect, it } from 'vitest'
import {
  isMissingRemoteRefGitError,
  isTransientReviewHeadFetchError
} from './fetch-error-classification'

describe('isMissingRemoteRefGitError', () => {
  it('matches missing remote ref messages', () => {
    expect(
      isMissingRemoteRefGitError(
        new Error('fatal: could not find remote ref refs/heads/feature/test')
      )
    ).toBe(true)
    expect(
      isMissingRemoteRefGitError(
        new Error("fatal: couldn't find remote ref refs/heads/feature/test")
      )
    ).toBe(true)
  })

  it('does not match auth or network failures', () => {
    expect(isMissingRemoteRefGitError(new Error('fatal: Authentication failed'))).toBe(false)
    expect(
      isMissingRemoteRefGitError(new Error('fatal: unable to access repo: Could not resolve host'))
    ).toBe(false)
  })
})

describe('isTransientReviewHeadFetchError', () => {
  it('classifies transport failures as transient', () => {
    const transient = [
      'fatal: unable to access repo: Could not resolve host: github.com',
      'Network error. Check your connection.',
      'fatal: unable to access repo: Connection refused',
      'error: RPC failed; curl 56 Recv failure: Connection reset by peer',
      'fetch-pack: unexpected disconnect while reading sideband packet: early EOF',
      'fatal: the remote end hung up unexpectedly',
      'Fetching refs/pull/42/head from "origin" timed out.',
      'fatal: unable to access repo: The requested URL returned error: 502'
    ]
    for (const message of transient) {
      expect(isTransientReviewHeadFetchError(new Error(message)), message).toBe(true)
    }
  })

  it('classifies an exec-timeout kill as transient without a message match', () => {
    const killed = Object.assign(new Error('Command failed: git fetch --no-tags origin'), {
      killed: true,
      signal: 'SIGTERM'
    })
    expect(isTransientReviewHeadFetchError(killed)).toBe(true)
  })

  it('fails hard on missing-ref, auth, protocol, and stale-relay errors', () => {
    const fatal = [
      "fatal: couldn't find remote ref refs/pull/42/head",
      'fatal: could not find remote ref refs/merge-requests/42/head',
      'Authentication failed. Check your remote credentials.',
      'fatal: could not read Username for https://github.com',
      'remote: Repository not found.',
      'fatal: unable to access repo: The requested URL returned error: 403',
      'This SSH host is running an older Orca relay that cannot fetch pull request heads. Reconnect to deploy the latest relay, then try again.',
      'Remote "origin" is not configured.',
      'fatal: invalid refspec'
    ]
    for (const message of fatal) {
      expect(isTransientReviewHeadFetchError(new Error(message)), message).toBe(false)
    }
  })
})
