import { describe, expect, it } from 'vitest'
import { getManagedScript as getAntigravityManagedScript } from '../antigravity/hook-script'
import { getManagedScript as getClaudeManagedScript } from '../claude/hook-script'
import { getManagedScript as getCodexManagedScript } from '../codex/codex-hook-script'
import { getGrokManagedScript } from '../grok/grok-hook-script'
import { buildPosixScrubSafeEnvRestoreLines } from '../../shared/agent-hook-scrub-safe-env'

const POSIX_SCRIPTS: readonly (readonly [agent: string, script: string])[] = [
  ['claude', getClaudeManagedScript('posix')],
  ['codex', getCodexManagedScript('posix')],
  ['grok', getGrokManagedScript('posix')],
  ['antigravity', getAntigravityManagedScript('posix')]
]

describe.each(POSIX_SCRIPTS)('%s managed POSIX hook', (_agent, script) => {
  const lines = script.split('\n')
  const restore = buildPosixScrubSafeEnvRestoreLines()
  const restoreStart = lines.indexOf(restore[0]!)

  it('restores the canonical pane identity from its scrub-safe aliases', () => {
    expect(restoreStart).toBeGreaterThanOrEqual(0)
    expect(lines.slice(restoreStart, restoreStart + restore.length)).toEqual(restore)
  })

  // Why: a scrubbing harness leaves ORCA_PANE_KEY empty, and this guard then exits without
  // posting — the pane reads as an agent Orca never hears from.
  it('restores before the guard that exits on a missing pane key', () => {
    const guard = lines.findIndex((line) => line.includes('-z "$ORCA_PANE_KEY"'))
    expect(guard).toBeGreaterThan(restoreStart + restore.length - 1)
  })

  it('restores before the spool fallback reads the pane key', () => {
    const spool = lines.findIndex((line) => line.includes('${ORCA_PANE_KEY:-}'))
    expect(spool).toBeGreaterThan(restoreStart + restore.length - 1)
  })
})
