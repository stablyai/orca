import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals as codexInternals } from '../codex/hook-service'
import { buildPosixHookSpoolLines } from './hook-stdin-contract'

/** Managed hooks are installed into the user's agent config, so they also run when the
 *  agent is launched from a plain terminal. There they must be inert and silent. */
function runHook(dir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const script = join(dir, 'codex-hook.sh')
  writeFileSync(script, codexInternals.getManagedScript('posix'))
  chmodSync(script, 0o755)
  const clean: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('ORCA_')) {
      clean[k] = v
    }
  }
  return spawnSync('/bin/sh', [script], {
    input: '{"hook_event_name":"SubagentStop","agent_id":"child"}\n',
    env: { ...clean, ...extraEnv },
    timeout: 5000,
    encoding: 'utf8'
  })
}

describe('managed hook outside an Orca terminal', () => {
  it('no Orca env at all: silent, exit 0, writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-outside-'))
    const res = runHook(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    expect(readdirSync(dir)).toEqual(['codex-hook.sh'])
  })

  it('pane key present but no endpoint: still silent and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-outside-partial-'))
    const res = runHook(dir, { ORCA_PANE_KEY: 'tab:0', ORCA_TAB_ID: 'tab' })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    expect(readdirSync(dir)).toEqual(['codex-hook.sh'])
  })

  it('endpoint points at a path that does not exist: silent, exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-outside-stale-'))
    const res = runHook(dir, {
      ORCA_AGENT_HOOK_ENDPOINT: join(dir, 'gone', 'deeper', 'endpoint.env'),
      ORCA_PANE_KEY: 'tab:0'
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    // a stale env var must not create a spool tree for an Orca that is not installed here
    expect(readdirSync(dir)).toEqual(['codex-hook.sh'])
  })

  it('readable endpoint without a pane key: silent, writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-outside-readable-'))
    const endpoint = join(dir, 'endpoint.env')
    writeFileSync(endpoint, 'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=stale\n')
    const res = runHook(dir, { ORCA_AGENT_HOOK_ENDPOINT: endpoint })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    expect(readdirSync(dir).sort()).toEqual(['codex-hook.sh', 'endpoint.env'])
  })
})

describe('antigravity out-of-band event name', () => {
  it('records hookEventName and filters tool progress on it', () => {
    const lines = buildPosixHookSpoolLines('antigravity', 'ORCA_ANTIGRAVITY_EVENT').join('\n')
    expect(lines).toContain('"hookEventName":"%s"')
    expect(lines).toContain('${ORCA_ANTIGRAVITY_EVENT:-}')
    expect(lines).toContain('in PreToolUse|PostToolUse|PostToolUseFailure) return 0')
    // payload-based filtering stays the default for every other provider
    expect(buildPosixHookSpoolLines('codex').join('\n')).toContain('case "$payload" in')
  })
})
