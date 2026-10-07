import { describe, expect, it } from 'vitest'
import { CODEX_EVENT_LABEL } from './codex-hook-definition'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { parseCodexTrustKey } from './codex-trust-identity'
import { computeTrustedHash, type CodexTrustEntry } from './config-toml-trust'

// Why: Orca's frozen form-1 POSIX command and the hash codex-cli 0.159.3 `hooks/list` reported
// for it as an Interrupt hook with `timeout: 3`; fails loudly if Codex's normalization drifts.
const ORCA_FORM_1_COMMAND =
  ': orca-agent-hook-form=1; if [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" ]; then /bin/sh "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" || :; elif [ -z "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_PORT-}" ] && [ -f "${HOME-}/.orca/agent-hooks/codex-hook.sh" ]; then /bin/sh "${HOME-}/.orca/agent-hooks/codex-hook.sh" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi'
const REAL_INTERRUPT_HASH =
  'sha256:78b430d1d7794c49e6d83a36964d4082d05ec72023ccc38244e97b8e08d054d2'

const INTERRUPT_ENTRY: CodexTrustEntry = {
  sourcePath: '/home/dev/.codex/hooks.json',
  eventLabel: 'interrupt',
  groupIndex: 0,
  handlerIndex: 0,
  command: ORCA_FORM_1_COMMAND,
  timeoutSec: 3
}

describe('the managed Codex Interrupt hook', () => {
  it('uses the trust key label Codex uses', () => {
    expect(CODEX_EVENT_LABEL.Interrupt).toBe('interrupt')
    expect(parseCodexTrustKey('/home/dev/.codex/hooks.json:interrupt:0:0')).toMatchObject({
      eventLabel: 'interrupt'
    })
  })

  it('reproduces the hash real Codex computed for the Interrupt hook', () => {
    expect(computeTrustedHash(INTERRUPT_ENTRY)).toBe(REAL_INTERRUPT_HASH)
  })

  it('hashes the timeout Codex clamps to, so an over-cap entry stays trusted', () => {
    // Why: Codex clamps Interrupt to [1, 3] and defaults it to 1 before hashing.
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, timeoutSec: 10 })).toBe(REAL_INTERRUPT_HASH)
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, timeoutSec: undefined })).toBe(
      computeTrustedHash({ ...INTERRUPT_ENTRY, timeoutSec: 1 })
    )
    expect(getCodexHookTrustSignature({ ...INTERRUPT_ENTRY, timeoutSec: 10 })).toBe(
      getCodexHookTrustSignature(INTERRUPT_ENTRY)
    )
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, eventLabel: 'stop', timeoutSec: 10 })).not.toBe(
      computeTrustedHash({ ...INTERRUPT_ENTRY, eventLabel: 'stop', timeoutSec: 3 })
    )
  })

  it('ignores a matcher, as Codex does for Interrupt', () => {
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, matcher: 'anything' })).toBe(
      REAL_INTERRUPT_HASH
    )
  })
})
