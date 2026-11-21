import { afterEach, describe, expect, it } from 'vitest'

import { computeCodexTrustedHash as computeTrustedHash } from '../identity/codex-trust-identity'
import type { CodexTrustEntry } from '../toml/config-toml-trust'
import { createCodexHookTrustEntry } from '../../hooks/definitions/codex-hook-identity'

// Frozen form-1 fixture: codex-cli 0.159.3 hooks/list reported this Interrupt hash with timeout 3.
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
  it('reproduces the hash real Codex computed for the Interrupt hook', () => {
    expect(computeTrustedHash(INTERRUPT_ENTRY)).toBe(REAL_INTERRUPT_HASH)
  })
})

// Frozen from codex-cli 0.162.1 and 0.170.0 hooks/list for this command.
const PROBE_COMMAND = 'node -e "process.exit(0)"'

describe('the SessionEnd hook', () => {
  it.each<
    [string, Omit<CodexTrustEntry, 'sourcePath' | 'groupIndex' | 'handlerIndex' | 'command'>]
  >([
    [
      'sha256:9a8e5508f1534981f66caf8ad29fe27d669188ee71e2d6e3ef56d8e65390f578',
      { eventLabel: 'session_end' }
    ],
    [
      'sha256:b4f5513d145df2d6d400f79b73a8f6e1a4eaa96484fbe4b793e802d7906e9e02',
      { eventLabel: 'session_end', matcher: 'other', timeoutSec: 9 }
    ]
  ])('reproduces the hash real Codex computed (%s)', (hash, entry) => {
    expect(
      computeTrustedHash({
        sourcePath: '/home/dev/.codex/hooks.json',
        groupIndex: 0,
        handlerIndex: 0,
        command: PROBE_COMMAND,
        ...entry
      })
    ).toBe(hash)
  })
})

describe('a hook with a Windows command override', () => {
  const originalPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })
  const hook = { type: 'command' as const, command: 'echo unix', commandWindows: 'echo windows' }

  it.each([
    ['C:\\Users\\dev\\.codex\\hooks.json', 'echo windows'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\hooks.json', 'echo unix']
  ])('is trusted for the command Codex runs from %s on Windows', (sourcePath, command) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(
      createCodexHookTrustEntry(sourcePath, 'Stop', 0, 0, { hooks: [hook] }, hook)?.command
    ).toBe(command)
  })
})
