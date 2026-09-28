// Every managed POSIX hook script, run for real under /bin/sh: with the inbox advertised it must
// commit the event without starting curl; without it, it must POST exactly as before.
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { parseAgentHookInboxRecord } from '../../shared/agent-hook-inbox-record'
import { getManagedScript as antigravityScript } from '../antigravity/hook-script'
import { getManagedScript as claudeScript } from '../claude/hook-script'
import { getManagedScript as codexScript } from '../codex/codex-hook-script'
import { buildCommandCodeManagedScript } from '../command-code/command-code-managed-script'
import { getManagedScript as copilotScript } from '../copilot/copilot-managed-script'
import { getManagedScript as cursorScript } from '../cursor/hook-script'
import { _internals as devin } from '../devin/hook-service'
import { _internals as droid } from '../droid/hook-service'
import { _internals as dsh } from '../dsh/hook-service'
import { _internals as gemini } from '../gemini/hook-service'
import { getGrokManagedScript } from '../grok/grok-hook-script'
import { _internals as kimi } from '../kimi/hook-service'
import { _internals as muse } from '../muse/hook-service'
import { _internals as zcode } from '../zcode/hook-service'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

type Case = {
  source: string
  script: () => string
  env?: NodeJS.ProcessEnv
  /** Body fields beyond the pane identity that this agent's POST carries. */
  extraBody?: Record<string, string>
  /** What the script must still print for its agent before anything else. */
  stdout?: string
}

const CASES: Case[] = [
  { source: 'claude', script: () => claudeScript('posix'), stdout: '{}\n' },
  { source: 'qoder', script: () => claudeScript('posix', { source: 'qoder' }), stdout: '{}\n' },
  { source: 'codex', script: () => codexScript('posix') },
  {
    source: 'grok',
    script: () => getGrokManagedScript('posix'),
    env: { GROK_HOME: '/home/grok' },
    extraBody: { grokHome: '/home/grok' }
  },
  { source: 'cursor', script: () => cursorScript('posix'), stdout: '{}\n' },
  { source: 'gemini', script: () => gemini.getManagedScript('posix'), stdout: '{}\n' },
  { source: 'droid', script: () => droid.getManagedScript('posix') },
  { source: 'devin', script: () => devin.getManagedScript('posix') },
  { source: 'kimi', script: () => kimi.getManagedScript('posix') },
  {
    source: 'copilot',
    script: () => copilotScript('posix'),
    env: { ORCA_COPILOT_HOOK_EVENT: 'Stop' },
    extraBody: { hookEventName: 'Stop' },
    stdout: '{}\n'
  },
  { source: 'command-code', script: () => buildCommandCodeManagedScript('posix') },
  {
    source: 'antigravity',
    script: () => antigravityScript('posix'),
    env: { ORCA_ANTIGRAVITY_EVENT: 'Stop' },
    extraBody: { hook_event_name: 'Stop' },
    stdout: '{"decision":""}\n'
  },
  { source: 'muse', script: () => muse.getManagedScript('posix') },
  { source: 'zcode', script: () => zcode.getManagedScript('posix') },
  { source: 'dsh', script: () => dsh.getManagedScript('posix') }
]

function runScript(testCase: Case, options: { inbox: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), `orca-inbox-${testCase.source}-`))
  const endpointDir = join(dir, 'agent-hooks')
  const inbox = join(endpointDir, 'hook-inbox')
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  const endpoint = join(endpointDir, 'endpoint.env')
  writeFileSync(
    endpoint,
    [
      'ORCA_AGENT_HOOK_PORT=9',
      'ORCA_AGENT_HOOK_TOKEN=token',
      'ORCA_AGENT_HOOK_ENV=production',
      'ORCA_AGENT_HOOK_VERSION=1',
      ...(options.inbox ? ['ORCA_AGENT_HOOK_INBOX=1'] : []),
      ''
    ].join('\n')
  )
  // A curl stand-in that records its stdin, so "no POST" and "POST carried the payload" are both
  // observable without a listener.
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const curlLog = join(dir, 'curl.log')
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh\n{ command -p cat 2>/dev/null || cat; } >> "${curlLog}"\nexit 0\n`
  )
  chmodSync(join(bin, 'curl'), 0o755)
  const script = join(dir, 'hook.sh')
  writeFileSync(script, testCase.script())
  chmodSync(script, 0o755)
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ORCA_') && key !== 'GROK_HOOK_EVENT' && key !== 'CLAUDE_JOB_DIR') {
      env[key] = value
    }
  }
  const payload = '{"hook_event_name":"Stop","session_id":"s-1","note":"100% ok"}'
  const result = spawnSync('/bin/sh', [script], {
    input: payload,
    env: {
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ORCA_AGENT_HOOK_ENDPOINT: endpoint,
      ORCA_AGENT_HOOK_PORT: '9',
      ORCA_AGENT_HOOK_TOKEN: 'token',
      ORCA_PANE_KEY: PANE_KEY,
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'repo::/work',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-token',
      ...testCase.env
    },
    encoding: 'utf8',
    timeout: 15_000
  })
  return {
    result,
    payload,
    records: readdirSync(inbox).map((name) => readFileSync(join(inbox, name))),
    curl: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : null
  }
}

describe.skipIf(process.platform === 'win32').each(CASES)('$source managed hook', (testCase) => {
  it('commits the event to the advertised inbox and never starts curl', () => {
    const { result, payload, records, curl } = runScript(testCase, { inbox: true })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(testCase.stdout ?? '')
    expect(curl).toBeNull()
    expect(records).toHaveLength(1)
    expect(parseAgentHookInboxRecord(records[0]!)).toEqual({
      kind: 'complete',
      record: {
        source: testCase.source,
        body: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'repo::/work',
          env: 'production',
          version: '1',
          launchToken: 'launch-token',
          ...testCase.extraBody,
          payload
        }
      }
    })
  })

  it('POSTs as before when its Orca does not advertise the inbox', () => {
    const { result, payload, records, curl } = runScript(testCase, { inbox: false })
    expect(result.status).toBe(0)
    expect(records).toHaveLength(0)
    expect(curl).toContain(payload)
  })
})
