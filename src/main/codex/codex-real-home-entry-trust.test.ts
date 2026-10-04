import { describe, expect, it } from 'vitest'
import { readOrcaEntryTrust } from './codex-real-home-entry-trust'
import {
  computeTrustedHash,
  readHookTrustEntriesFromContent,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from './config-toml-trust'

const ENTRY: CodexTrustEntry = {
  sourcePath: '/home/jin/.codex/hooks.json',
  eventLabel: 'stop',
  groupIndex: 1,
  handlerIndex: 0,
  command: ': orca-agent-hook-form=1; /bin/sh "${HOME-}/.orca/agent-hooks/codex-hook.sh"',
  timeoutSec: 10
}

function trustAfter(
  entries: CodexTrustEntry[]
): ReturnType<typeof readHookTrustEntriesFromContent> {
  return readHookTrustEntriesFromContent(upsertHookTrustEntriesInContent('', entries))
}

describe('readOrcaEntryTrust', () => {
  it('reads a present entry with the current hash as trusted', () => {
    expect(readOrcaEntryTrust(ENTRY, trustAfter([ENTRY]))).toBe('trusted')
  })

  it('reads an entry with no trust block as untrusted', () => {
    expect(readOrcaEntryTrust(ENTRY, trustAfter([]))).toBe('untrusted')
  })

  it('reads a hash for another command at the same key as stale', () => {
    const trust = trustAfter([
      { ...ENTRY, trustedHash: computeTrustedHash({ ...ENTRY, command: 'x' }) }
    ])

    expect(readOrcaEntryTrust(ENTRY, trust)).toBe('stale')
  })

  it('reads an entry the user turned off as disabled, whatever its hash', () => {
    expect(readOrcaEntryTrust(ENTRY, trustAfter([{ ...ENTRY, enabled: false }]))).toBe('disabled')
  })
})
