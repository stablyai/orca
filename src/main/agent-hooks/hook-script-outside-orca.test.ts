import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getManagedScript } from '../codex/codex-hook-script'
import { buildPosixHookSpoolLines } from './hook-stdin-contract'

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
})

describe('antigravity out-of-band event name', () => {
  it.skipIf(process.platform === 'win32').each([
    ['antigravity', 'SessionStart', '{"type":"session"}', true],
    ['antigravity', 'PreToolUse', '{"type":"session"}', false],
    ['antigravity', 'PostToolUse', '{"type":"session"}', false],
    ['antigravity', 'PostToolUseFailure', '{"type":"session"}', false],
    ['codex', '', '{"hook_event_name":"PreToolUse"}', false],
    ['codex', '', '{"hook_event_name":"Stop"}', true]
  ])('spools %s %s according to its event source', (source, event, payload, shouldSpool) => {
    const dir = createTempDir('orca-spool-event-')
    const endpoint = join(dir, 'endpoint.env')
    writeFileSync(endpoint, '')
    const script = [
      ...buildPosixHookSpoolLines(
        source,
        source === 'antigravity' ? 'ORCA_ANTIGRAVITY_EVENT' : undefined
      ),
      'payload="$ORCA_TEST_PAYLOAD"',
      'spool_hook_event'
    ].join('\n')
    const result = spawnSync('/bin/sh', ['-c', script], {
      env: {
        PATH: '/usr/bin:/bin',
        ORCA_AGENT_HOOK_ENDPOINT: endpoint,
        ORCA_PANE_KEY: 'tab:leaf',
        ORCA_ANTIGRAVITY_EVENT: event,
        ORCA_TEST_PAYLOAD: payload
      },
      timeout: 5000,
      encoding: 'utf8'
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    const spoolDir = join(dir, 'spool')
    const files = existsSync(spoolDir) ? readdirSync(spoolDir) : []
    expect(files).toHaveLength(shouldSpool ? 1 : 0)
    if (shouldSpool) {
      const record = JSON.parse(readFileSync(join(spoolDir, files[0]), 'utf8').trim())
      expect(record.source).toBe(source)
      expect(record.payload).toEqual(JSON.parse(payload))
      expect(record.hookEventName).toBe(source === 'antigravity' ? event : undefined)
    }
  })
})
