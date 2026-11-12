import { readSavedStatus } from '../persistence/last-status.test-fixtures'
import { describe, expect, it } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_HOOK_SPOOL_MAX_FILES,
  drainAgentHookSpoolAsync,
  launchTokenHash,
  type SpoolRecord
} from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody } from '../server.test-fixtures'
import { _internals as codexInternals } from '../../../../codex/hooks/installation/hook-service'
import { getManagedScript as getClaudeManagedScript } from '../../../../claude/hook-script'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

describe('agent hook spool', () => {
  it('waits for a newline before replaying a complete-looking final record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-unterminated-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'pane-live.jsonl')
    const record = JSON.stringify({
      paneKey: 'tab:live',
      source: 'codex',
      receivedAt: Date.now(),
      payload: { state: 'done' }
    })
    writeFileSync(file, record)
    const ingested: SpoolRecord[] = []
    const options = {
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (value: SpoolRecord) => {
        ingested.push(value)
      }
    }
    expect(await drainAgentHookSpoolAsync(options)).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(record)

    appendFileSync(file, '\n')
    expect(await drainAgentHookSpoolAsync(options)).toBe(1)
    expect(ingested).toHaveLength(1)
    expect(readFileSync(file)).toHaveLength(0)
  })

  it('does not let historical empty pane files starve newer records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-empty-files-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    for (let index = 0; index < AGENT_HOOK_SPOOL_MAX_FILES; index += 1) {
      writeFileSync(join(spool, `pane-empty-${index}.jsonl`), '')
    }
    const live = join(spool, 'pane-live.jsonl')
    writeFileSync(
      live,
      `\n${JSON.stringify({ paneKey: 'tab:live', source: 'codex', receivedAt: Date.now(), payload: { state: 'done' } })}\n`
    )
    const ingested: SpoolRecord[] = []
    await drainAgentHookSpoolAsync({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (record) => {
        ingested.push(record)
      }
    })
    expect(ingested).toHaveLength(1)
    expect(ingested[0]?.paneKey).toBe('tab:live')
  })

  it('rejects stale launch tokens before ingest and truncates in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'pane-1.jsonl')
    writeFileSync(
      file,
      `\n${JSON.stringify({ paneKey: 'tab:1', source: 'codex', launchToken: 'old', receivedAt: Date.now(), payload: { state: 'done' } })}\n`
    )
    const inode = statSync(file).ino
    const ingested: unknown[] = []
    await drainAgentHookSpoolAsync({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => launchTokenHash('new')!,
      ingest: (record) => {
        ingested.push(record)
      }
    })
    expect(ingested).toHaveLength(0)
    expect(readFileSync(file)).toHaveLength(0)
    expect(statSync(file).ino).toBe(inode)
  })

  it('replays a spooled Codex SubagentStop through the server after restart', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-spool-e2e-'))
    const paneKey = makePaneKey('tab-spool', '00000000-0000-4000-8000-000000000001')
    const launchToken = 'generation-token'
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    const started = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'child-spooled' }),
      'production'
    )!
    first.ingestRemote(
      {
        paneKey,
        source: 'codex',
        hookEventName: 'SubagentStart',
        launchToken,
        payload: started.payload
      },
      'spool-test'
    )
    expect(first.getStatusSnapshot()).toHaveLength(1)
    first.flushStatusPersistSync()
    first.stop()
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      join(spoolDir, 'pane-tab-spooled_0.jsonl'),
      `\n${JSON.stringify({ paneKey, source: 'codex', hookEventName: 'SubagentStop', launchToken, receivedAt: Date.now(), payload: { hook_event_name: 'SubagentStop', agent_id: 'child-spooled' } })}\n`
    )
    const restarted = new AgentHookServer()
    await restarted.start({ env: 'production', userDataPath })
    try {
      const snapshot = restarted.getStatusSnapshot()
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]!.subagents).toBeUndefined()
      restarted.flushStatusPersistSync()
      expect(readSavedStatus(restarted.lastStatusPath!)).not.toContain('isReplay')
    } finally {
      restarted.stop()
    }
  })

  it('rejects a stale remote replay against the hydrated launch-token fence', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-spool-remote-fence-'))
    const paneKey = makePaneKey('tab-remote-fence', '00000000-0000-4000-8000-000000000003')
    const first = new AgentHookServer()
    const second = new AgentHookServer()
    try {
      await first.start({ env: 'production', userDataPath })
      first.ingestRemote(
        {
          paneKey,
          source: 'codex',
          launchToken: 'old-generation',
          payload: { state: 'working', agentType: 'codex', prompt: 'old' }
        },
        'ssh-1'
      )
      first.flushStatusPersistSync()
      first.stop()

      await second.start({ env: 'production', userDataPath })
      second.ingestRemote(
        {
          paneKey,
          source: 'codex',
          launchToken: 'new-generation',
          isReplay: true,
          payload: { state: 'done', agentType: 'codex', prompt: 'stale completion' }
        },
        'ssh-2'
      )
      expect(second.getStatusSnapshot()[0]).toMatchObject({
        paneKey,
        state: 'working',
        prompt: 'old'
      })
    } finally {
      first.stop()
      second.stop()
    }
  })

  it('spools when the endpoint is present but the receiver is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-failure-'))
    const endpointDir = join(dir, 'agent-hooks')
    mkdirSync(endpointDir, { recursive: true })
    const endpoint = join(endpointDir, 'endpoint.env')
    writeFileSync(
      endpoint,
      'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=stale\nORCA_AGENT_HOOK_ENV=production\nORCA_AGENT_HOOK_VERSION=1\n'
    )
    const script = join(dir, 'codex-hook.sh')
    writeFileSync(script, codexInternals.getManagedScript('posix'))
    chmodSync(script, 0o755)
    execFileSync('/bin/sh', [script], {
      input: '{"hook_event_name":"SubagentStop","agent_id":"child"}\n',
      env: {
        ...process.env,
        ORCA_AGENT_HOOK_ENDPOINT: endpoint,
        ORCA_PANE_KEY: 'tab-failure:0',
        ORCA_TAB_ID: 'tab-failure',
        ORCA_AGENT_LAUNCH_TOKEN: 'generation-token',
        CLAUDE_JOB_DIR: ''
      },
      timeout: 5000
    })
    const spoolFiles = readdirSync(join(endpointDir, 'spool'))
    expect(spoolFiles).toHaveLength(1)
    expect(readFileSync(join(endpointDir, 'spool', spoolFiles[0]!), 'utf8')).toContain(
      'SubagentStop'
    )
  })

  it('keeps a Claude hook attributed when CLAUDE_CODE_SUBPROCESS_ENV_SCRUB drops the pane key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-scrubbed-'))
    const endpointDir = join(dir, 'agent-hooks')
    mkdirSync(endpointDir, { recursive: true })
    const endpoint = join(endpointDir, 'endpoint.env')
    writeFileSync(endpoint, 'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=stale\n')
    const script = join(dir, 'claude-hook.sh')
    writeFileSync(script, getClaudeManagedScript('posix'))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ORCA_AGENT_HOOK_ENDPOINT: endpoint,
      ORCA_AGENT_PANE: 'tab-scrubbed:0',
      ORCA_AGENT_LAUNCH: 'generation-token'
    }
    // Claude's scrub removes every *KEY/*TOKEN name; only the scrub-safe aliases reach the hook.
    delete env.ORCA_PANE_KEY
    delete env.ORCA_AGENT_LAUNCH_TOKEN
    delete env.CLAUDE_JOB_DIR
    execFileSync('/bin/sh', [script], {
      input: '{"hook_event_name":"Stop","session_id":"claude-session"}\n',
      env,
      timeout: 5000
    })
    const spoolFiles = readdirSync(join(endpointDir, 'spool'))
    expect(spoolFiles).toHaveLength(1)
    const record: unknown = JSON.parse(
      readFileSync(join(endpointDir, 'spool', spoolFiles[0]!), 'utf8').trim()
    )
    expect(record).toMatchObject({ paneKey: 'tab-scrubbed:0', launchToken: 'generation-token' })
  })

  it('never spools a Claude tool batch while the receiver is down, compact or spaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-batch-'))
    const endpointDir = join(dir, 'agent-hooks')
    mkdirSync(endpointDir, { recursive: true })
    const endpoint = join(endpointDir, 'endpoint.env')
    writeFileSync(endpoint, 'ORCA_AGENT_HOOK_PORT=9\nORCA_AGENT_HOOK_TOKEN=stale\n')
    const script = join(dir, 'claude-hook.sh')
    writeFileSync(script, getClaudeManagedScript('posix'))
    const run = (input: string) =>
      execFileSync('/bin/sh', [script], {
        input,
        env: {
          ...process.env,
          ORCA_AGENT_HOOK_ENDPOINT: endpoint,
          ORCA_PANE_KEY: 'tab-batch:0',
          ORCA_AGENT_LAUNCH_TOKEN: 'generation-token',
          CLAUDE_JOB_DIR: ''
        },
        timeout: 5000
      })
    run('{"hook_event_name":"PostToolBatch","tool_calls":[{"tool_use_id":"toolu-a"}]}\n')
    run('{"hook_event_name": "PostToolBatch", "tool_calls": [{"tool_use_id": "toolu-b"}]}\n')
    run('{"hook_event_name":"Stop","session_id":"claude-session"}\n')
    const spoolDir = join(endpointDir, 'spool')
    const records = readdirSync(spoolDir).flatMap((file) =>
      readFileSync(join(spoolDir, file), 'utf8').trim().split('\n')
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toContain('"Stop"')
  })

  it('does not mark a non-terminal downtime replay as runtime-observed', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-spool-observed-'))
    const paneKey = makePaneKey('tab-observed', '00000000-0000-4000-8000-000000000002')
    const launchToken = 'observed-generation'
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath })
    const started = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SubagentStart', agent_id: 'child-observed' }),
      'production'
    )!
    first.ingestRemote(
      {
        paneKey,
        source: 'codex',
        hookEventName: 'SubagentStart',
        launchToken,
        payload: started.payload
      },
      null
    )
    first.flushStatusPersistSync()
    first.stop()
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      join(spoolDir, 'pane-observed.jsonl'),
      `\n${JSON.stringify({ paneKey, source: 'codex', hookEventName: 'SubagentStart', launchToken, receivedAt: Date.now(), payload: started.payload })}\n`
    )
    const restarted = new AgentHookServer()
    await restarted.start({ env: 'production', userDataPath })
    try {
      expect(restarted.getStatusChangeSnapshot()[0]?.observedInCurrentRuntime).toBe(false)
    } finally {
      restarted.stop()
    }
  })
})
