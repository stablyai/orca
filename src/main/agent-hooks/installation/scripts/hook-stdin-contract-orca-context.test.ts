import { describe, expect, it } from 'vitest'
import {
  buildPosixHookPayloadCapture,
  POSIX_HOOK_JSON_STDIN,
  POSIX_HOOK_STDIN_DRAIN_COMMAND
} from './hook-stdin-contract'
import { getManagedScript as getClaudeManagedScript } from '../../../claude/hooks/hook-script'
import { getManagedScript as getAntigravityManagedScript } from '../../../antigravity/hook-script'

// The zero-context guard exists so a hook whose registration outlived its Orca drains stdin with
// one cat spawn instead of a python3 cold start per tool call (#42601).
const GUARD =
  'if [ -z "${ORCA_AGENT_HOOK_PORT:-}" ] && [ -z "${ORCA_AGENT_HOOK_TOKEN:-}" ] && [ -z "${ORCA_PANE_KEY:-}" ] && [ -z "${ORCA_AGENT_HOOK_ENDPOINT:-}" ]; then'

describe('posix hook payload capture orca-context guard', () => {
  it('drains and exits before the reader when no Orca context exists', () => {
    const lines = buildPosixHookPayloadCapture()
    const guardIndex = lines.indexOf(GUARD)
    expect(guardIndex).toBeGreaterThan(-1)
    expect(lines[guardIndex + 1]).toBe(`  ${POSIX_HOOK_STDIN_DRAIN_COMMAND}`)
    expect(lines[guardIndex + 2]).toBe('  exit 0')
    // The guard precedes the capture itself.
    expect(lines.findIndex((line) => line.startsWith('payload=$('))).toBeGreaterThan(guardIndex)
  })

  it('applies the same guard to the exec-cat reader used by write-close writers', () => {
    const lines = buildPosixHookPayloadCapture('exit', {
      reader: 'if [ -x /bin/cat ]; then exec /bin/cat; fi',
      prelude: []
    })
    expect(lines).toContain(GUARD)
  })

  it('keeps capture-first order for held-open stdin readers', () => {
    const lines = buildPosixHookPayloadCapture('empty-object', POSIX_HOOK_JSON_STDIN, {
      stdinHeldOpen: true
    })
    expect(lines).not.toContain(GUARD)
    // The bounded python reader runs before any exit.
    const readerIndex = lines.findIndex((line) => line.startsWith('payload=$('))
    const exitIndex = lines.indexOf('  exit 0')
    expect(exitIndex).toBe(-1)
    expect(readerIndex).toBeGreaterThan(-1)
  })

  it('emits the guard in the claude script but not in the antigravity script', () => {
    expect(getClaudeManagedScript('posix')).toContain(GUARD)
    expect(getAntigravityManagedScript('posix')).not.toContain(GUARD)
  })
})
