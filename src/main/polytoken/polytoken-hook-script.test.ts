import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPolytokenManagedCommand, getPolytokenManagedScript } from './polytoken-hook-script'

// Why: the hooks Polytoken gates on (pre_tool_use, pre_model_turn, stop) fail closed, so the
// generated script is executed for real under sh with a fake curl: any stdout or non-zero
// exit here would stall or alter the agent.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-polytoken-script-'))
  writeFileSync(join(dir, 'polytoken-hook.sh'), getPolytokenManagedScript())
  chmodSync(join(dir, 'polytoken-hook.sh'), 0o755)
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, 'curl-args')}"\ncat > "${join(dir, 'curl-stdin')}"\nexit "\${FAKE_CURL_EXIT:-0}"\n`
  )
  chmodSync(join(dir, 'curl'), 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(
  stdin: string,
  env: Record<string, string>
): { status: number | null; stdout: string } {
  const result = spawnSync('sh', [join(dir, 'polytoken-hook.sh')], {
    input: stdin,
    encoding: 'utf-8',
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env }
  })
  return { status: result.status, stdout: result.stdout }
}

const ORCA_ENV = {
  ORCA_AGENT_HOOK_PORT: '4242',
  ORCA_AGENT_HOOK_TOKEN: 'token',
  ORCA_PANE_KEY: 'tab:pane',
  ORCA_TAB_ID: 'tab',
  ORCA_WORKTREE_ID: 'wt'
}

describe('polytoken managed hook script', () => {
  it('passes syntax check and posts the payload with env-derived identity spliced in', () => {
    expect(spawnSync('sh', ['-n', join(dir, 'polytoken-hook.sh')]).status).toBe(0)
    const result = run('{"event":"pre_tool_use","tool_name":"file_read","input":{"path":"a"}}\n', {
      ...ORCA_ENV,
      POLYTOKEN_HOOK_EVENT: 'pre_tool_use',
      POLYTOKEN_SESSION_ID: '0a6mht-drum',
      POLYTOKEN_MODEL_NAME: 'zai/glm-5.3-flash'
    })
    expect(result).toEqual({ status: 0, stdout: '' })
    const args = readFileSync(join(dir, 'curl-args'), 'utf-8')
    expect(args).toContain('http://127.0.0.1:4242/hook/polytoken')
    expect(args).toContain('--max-time')
    const body = readFileSync(join(dir, 'curl-stdin'), 'utf-8')
    expect(JSON.parse(body)).toEqual({
      hook_event_name: 'pre_tool_use',
      session_id: '0a6mht-drum',
      model_name: 'zai/glm-5.3-flash',
      event: 'pre_tool_use',
      tool_name: 'file_read',
      input: { path: 'a' }
    })
  })

  it('lets the payload keep its own session_id and copes with empty objects and unsafe env', () => {
    run('  {"event":"session_start","session_id":"from-payload"}', {
      ...ORCA_ENV,
      POLYTOKEN_HOOK_EVENT: 'session_start',
      POLYTOKEN_SESSION_ID: 'from-env',
      POLYTOKEN_MODEL_NAME: 'bad"value'
    })
    expect(JSON.parse(readFileSync(join(dir, 'curl-stdin'), 'utf-8'))).toEqual({
      hook_event_name: 'session_start',
      session_id: 'from-payload',
      event: 'session_start'
    })

    run('{}', { ...ORCA_ENV, POLYTOKEN_HOOK_EVENT: 'stop' })
    expect(JSON.parse(readFileSync(join(dir, 'curl-stdin'), 'utf-8'))).toEqual({
      hook_event_name: 'stop'
    })

    const result = run('', { ...ORCA_ENV, POLYTOKEN_HOOK_EVENT: 'stop' })
    expect(result).toEqual({ status: 0, stdout: '' })
    expect(JSON.parse(readFileSync(join(dir, 'curl-stdin'), 'utf-8'))).toEqual({
      hook_event_name: 'stop'
    })
  })

  it('stays silent and exits 0 when Orca is absent or the post fails, and caps stdin', () => {
    const absent = run('{"event":"stop"}', { POLYTOKEN_HOOK_EVENT: 'stop' })
    expect(absent).toEqual({ status: 0, stdout: '' })
    expect(existsSync(join(dir, 'curl-args'))).toBe(false)

    const failed = run('{"event":"stop"}', {
      ...ORCA_ENV,
      POLYTOKEN_HOOK_EVENT: 'stop',
      FAKE_CURL_EXIT: '7'
    })
    expect(failed).toEqual({ status: 0, stdout: '' })

    const huge = `{"event":"post_tool_use","blob":"${'x'.repeat(300_000)}"}`
    const capped = run(huge, { ...ORCA_ENV, POLYTOKEN_HOOK_EVENT: 'post_tool_use' })
    expect(capped).toEqual({ status: 0, stdout: '' })
    expect(readFileSync(join(dir, 'curl-stdin'), 'utf-8').length).toBeLessThanOrEqual(262_144 + 200)
  })

  it('uses the raw-json transport with the base64 metadata header when Orca asks for it', () => {
    const result = run('{"event":"stop"}', {
      ...ORCA_ENV,
      ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
      POLYTOKEN_HOOK_EVENT: 'stop',
      POLYTOKEN_SESSION_ID: '0a6mht-drum'
    })
    expect(result).toEqual({ status: 0, stdout: '' })
    const args = readFileSync(join(dir, 'curl-args'), 'utf-8')
    expect(args).toContain('Content-Type: application/json')
    expect(args).toContain('X-Orca-Agent-Hook-Meta-Encoding: base64')
    expect(JSON.parse(readFileSync(join(dir, 'curl-stdin'), 'utf-8'))).toEqual({
      hook_event_name: 'stop',
      session_id: '0a6mht-drum',
      event: 'stop'
    })
  })

  it('wraps the handler so a missing script is a silent no-op outside Orca panes', () => {
    const command = getPolytokenManagedCommand('/nowhere/polytoken-hook.sh')
    const result = spawnSync('sh', ['-c', command], {
      input: '{"event":"stop"}',
      encoding: 'utf-8',
      env: { PATH: '/usr/bin:/bin', ORCA_PANE_KEY: 'tab:pane' }
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
