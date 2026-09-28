import { describe, expect, it } from 'vitest'
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

import { parseAgentHookInboxRecord } from '../../shared/agent-hook-inbox-record'
import { buildPosixHookInboxCommitLines } from './hook-inbox-commit'

const POSIX_SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash'].filter((shell) => existsSync(shell))

function makeEndpoint(lines: string[], options: { inbox?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-inbox-commit-'))
  const endpoint = join(dir, 'endpoint.env')
  writeFileSync(endpoint, `${lines.join('\n')}\n`)
  const inbox = join(dir, 'hook-inbox')
  if (options.inbox !== false) {
    mkdirSync(inbox, { mode: 0o700 })
  }
  return { dir, endpoint, inbox }
}

function runCommit(
  shell: string,
  endpoint: string,
  payload: string,
  env: NodeJS.ProcessEnv = {},
  commit = buildPosixHookInboxCommitLines('codex')
) {
  const script = join(mkdtempSync(join(tmpdir(), 'orca-inbox-script-')), 'hook.sh')
  writeFileSync(
    script,
    ['payload=$(cat)', ...commit, 'orca_hook_commit', 'echo "rc=$?"', ''].join('\n')
  )
  chmodSync(script, 0o755)
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ORCA_')) {
      clean[key] = value
    }
  }
  return spawnSync(shell, [script], {
    input: payload,
    env: {
      ...clean,
      ORCA_AGENT_HOOK_ENDPOINT: endpoint,
      ORCA_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'repo::/work/a % b\\c',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-token',
      ...env
    },
    encoding: 'utf8',
    timeout: 10_000
  })
}

const ENDPOINT_WITH_INBOX = [
  'ORCA_AGENT_HOOK_PORT=9',
  'ORCA_AGENT_HOOK_TOKEN=t',
  'ORCA_AGENT_HOOK_ENV=production',
  'ORCA_AGENT_HOOK_VERSION=1',
  'ORCA_AGENT_HOOK_INBOX=1'
]

describe.each(POSIX_SHELLS)('orca_hook_commit under %s', (shell) => {
  it('writes one complete record that round-trips to the POST body', () => {
    const { endpoint, inbox } = makeEndpoint(ENDPOINT_WITH_INBOX)
    const payload = '{"hook_event_name":"Stop","msg":"100% 日本語 \\\\ \\"q\\" $HOME `x`"}'
    const res = runCommit(shell, endpoint, payload)
    expect(res.stdout.trim()).toBe('rc=0')
    expect(res.stderr).toBe('')
    const names = readdirSync(inbox)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^\d+\.0\.rec$/)
    const parsed = parseAgentHookInboxRecord(readFileSync(join(inbox, names[0])))
    expect(parsed).toEqual({
      kind: 'complete',
      record: {
        source: 'codex',
        body: {
          paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
          tabId: 'tab-1',
          worktreeId: 'repo::/work/a % b\\c',
          env: 'production',
          version: '1',
          launchToken: 'launch-token',
          payload
        }
      }
    })
  })

  it('carries provider-specific body fields', () => {
    const { endpoint, inbox } = makeEndpoint(ENDPOINT_WITH_INBOX)
    const res = runCommit(
      shell,
      endpoint,
      '{}',
      { GROK_HOME_FOR_TEST: '/home/g' },
      buildPosixHookInboxCommitLines('grok', {
        extraFields: [{ key: 'grokHome', value: '${GROK_HOME_FOR_TEST:-}' }]
      })
    )
    expect(res.stdout.trim()).toBe('rc=0')
    const [name] = readdirSync(inbox)
    const parsed = parseAgentHookInboxRecord(readFileSync(join(inbox, name)))
    expect(parsed.kind === 'complete' && parsed.record.body.grokHome).toBe('/home/g')
    expect(parsed.kind === 'complete' && parsed.record.source).toBe('grok')
  })

  it('declines (so the script POSTs) when the endpoint file does not advertise the inbox', () => {
    const { endpoint, inbox } = makeEndpoint(ENDPOINT_WITH_INBOX.slice(0, -1))
    // An inherited variable must not enable the inbox: only the live endpoint file can.
    const res = runCommit(shell, endpoint, '{}', { ORCA_AGENT_HOOK_INBOX: '1' })
    expect(res.stdout.trim()).toBe('rc=1')
    expect(readdirSync(inbox)).toEqual([])
  })

  it('declines when the inbox directory is missing, without creating it', () => {
    const { endpoint, inbox } = makeEndpoint(ENDPOINT_WITH_INBOX, { inbox: false })
    const res = runCommit(shell, endpoint, '{}')
    expect(res.stdout.trim()).toBe('rc=1')
    expect(existsSync(inbox)).toBe(false)
  })

  it('declines without a pane key', () => {
    const { endpoint, inbox } = makeEndpoint(ENDPOINT_WITH_INBOX)
    const res = runCommit(shell, endpoint, '{}', { ORCA_PANE_KEY: '' })
    expect(res.stdout.trim()).toBe('rc=1')
    expect(readdirSync(inbox)).toEqual([])
  })

  it('never overwrites a record left by an earlier process with the same pid', () => {
    const { endpoint, inbox } = makeEndpoint(ENDPOINT_WITH_INBOX)
    // Occupy every name the next shell could pick for seq 0..2 by pre-creating by glob pattern is
    // impossible without knowing the pid, so run twice and assert both records survive.
    runCommit(shell, endpoint, '{"n":1}')
    runCommit(shell, endpoint, '{"n":2}')
    const payloads = readdirSync(inbox)
      .map((name) => parseAgentHookInboxRecord(readFileSync(join(inbox, name))))
      .map((parsed) => (parsed.kind === 'complete' ? parsed.record.body.payload : null))
      .sort()
    expect(payloads).toEqual(['{"n":1}', '{"n":2}'])
  })

  it('sheds only tool progress, and only once a backlog shows nothing drains', () => {
    const { endpoint, inbox } = makeEndpoint(ENDPOINT_WITH_INBOX)
    // A stalled but live Orca builds a backlog too; its tool events still matter (they release
    // a permission wait), so nothing is shed short of the closed-Orca limit.
    for (let index = 0; index < 1999; index += 1) {
      writeFileSync(join(inbox, `1.${index}.rec`), 'x')
    }
    expect(runCommit(shell, endpoint, '{"hook_event_name":"PreToolUse"}').stdout.trim()).toBe(
      'rc=0'
    )
    expect(readdirSync(inbox)).toHaveLength(2000)
    expect(runCommit(shell, endpoint, '{"hook_event_name":"PostToolUse"}').stdout.trim()).toBe(
      'rc=0'
    )
    expect(readdirSync(inbox)).toHaveLength(2000)
    expect(runCommit(shell, endpoint, '{"hook_event_name":"Stop"}').stdout.trim()).toBe('rc=0')
    expect(readdirSync(inbox)).toHaveLength(2001)
  })
})
