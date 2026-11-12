import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getManagedScript } from '../../../codex/hooks/definitions/codex-hook-script'

const roots: string[] = []

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** User-global hooks also run outside Orca, where they must stay inert and silent. */
function runHook(dir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const script = join(dir, 'codex-hook.sh')
  writeFileSync(script, getManagedScript('posix'))
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

describe.skipIf(process.platform === 'win32')('managed hook outside an Orca terminal', () => {
  it('no Orca env at all: silent, exit 0, writes nothing', () => {
    const dir = createTempDir('orca-outside-')
    const res = runHook(dir)
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    expect(readdirSync(dir)).toEqual(['codex-hook.sh'])
  })

  it('endpoint points at a path that does not exist: silent, exit 0', () => {
    const dir = createTempDir('orca-outside-stale-')
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
    const dir = createTempDir('orca-outside-readable-')
    const endpoint = join(dir, 'endpoint.env')
    writeFileSync(endpoint, 'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=stale\n')
    const res = runHook(dir, { ORCA_AGENT_HOOK_ENDPOINT: endpoint })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('')
    expect(readdirSync(dir).sort()).toEqual(['codex-hook.sh', 'endpoint.env'])
  })

  it('Claude background job with an inherited pane env: neither posts nor spools', () => {
    const dir = createTempDir('orca-outside-claude-job-')
    const endpoint = join(dir, 'endpoint.env')
    writeFileSync(endpoint, 'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=stale\n')
    const res = runHook(dir, {
      ORCA_AGENT_HOOK_ENDPOINT: endpoint,
      ORCA_PANE_KEY: 'tab:0',
      CLAUDE_JOB_DIR: join(dir, 'job')
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    // A failed post would spool beside the endpoint file.
    expect(readdirSync(dir).sort()).toEqual(['codex-hook.sh', 'endpoint.env'])
  })
})
