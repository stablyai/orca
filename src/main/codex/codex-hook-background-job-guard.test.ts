import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getManagedScript } from './codex-hook-script'

const describePosix = process.platform === 'win32' ? describe.skip : describe

function runCodexHook(extraEnv: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-codex-job-guard-'))
  const binDir = join(dir, 'bin')
  const curlLog = join(dir, 'curl-calls.log')
  mkdirSync(binDir)
  const fakeCurl = join(binDir, 'curl')
  writeFileSync(fakeCurl, `#!/bin/sh\necho called >> "${curlLog}"\ncat >/dev/null\nexit 0\n`)
  chmodSync(fakeCurl, 0o755)
  const endpointDir = join(dir, 'endpoint')
  mkdirSync(endpointDir)
  const endpoint = join(endpointDir, 'endpoint.env')
  writeFileSync(endpoint, 'ORCA_AGENT_HOOK_PORT=1\nORCA_AGENT_HOOK_TOKEN=fake-token\n')
  const script = join(dir, 'codex-hook.sh')
  writeFileSync(script, getManagedScript('posix'))
  chmodSync(script, 0o755)

  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ORCA_') && key !== 'CLAUDE_JOB_DIR') {
      env[key] = value
    }
  }
  const res = spawnSync('/bin/sh', [script], {
    input: '{"hook_event_name":"UserPromptSubmit","session_id":"s1"}\n',
    env: {
      ...env,
      PATH: `${binDir}${delimiter}${env.PATH ?? ''}`,
      ORCA_AGENT_HOOK_ENDPOINT: endpoint,
      ORCA_AGENT_HOOK_PORT: '1',
      ORCA_AGENT_HOOK_TOKEN: 'fake-token',
      ORCA_PANE_KEY: 'fake-tab:0',
      ...extraEnv
    },
    timeout: 5000,
    encoding: 'utf8'
  })
  const curlCalls = existsSync(curlLog)
    ? readFileSync(curlLog, 'utf8').split('\n').filter(Boolean).length
    : 0
  return { res, curlCalls, spoolExists: existsSync(join(endpointDir, 'spool')) }
}

describePosix('codex hook under a Claude background job', () => {
  it('posts to the server when CLAUDE_JOB_DIR is unset', () => {
    const { res, curlCalls } = runCodexHook({})
    expect(res.status).toBe(0)
    expect(curlCalls).toBe(1)
  })

  it('neither posts nor spools when CLAUDE_JOB_DIR is set', () => {
    const { res, curlCalls, spoolExists } = runCodexHook({ CLAUDE_JOB_DIR: '/fake/job' })
    expect(res.status).toBe(0)
    expect(curlCalls).toBe(0)
    expect(spoolExists).toBe(false)
  })

  it('guards the Windows script before the post and exits instead of draining', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const lines = getManagedScript('local').split('\r\n')
      const guard = lines.indexOf('if not "%CLAUDE_JOB_DIR%"=="" exit /b 0')
      const post = lines.findIndex((line) => line.includes('curl'))
      expect(guard).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(post)
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })
})
