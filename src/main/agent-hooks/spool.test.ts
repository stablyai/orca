import { describe, expect, it } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_HOOK_SPOOL_MAX_FILES,
  drainAgentHookSpool,
  launchTokenHash,
  readSpoolRecords,
  type SpoolRecord
} from '../../shared/agent-hook-spool'
import { AgentHookServer, _internals } from './server'
import { buildBody } from './server.test-fixtures'
import { _internals as codexInternals } from '../codex/hook-service'
import { getManagedScript as getClaudeScript } from '../claude/hook-script'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildPosixHookSpoolLines } from './hook-stdin-contract'

function runPosixHook(script: string, input: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [script], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('managed hook did not exit'))
    }, 15_000)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`managed hook exited ${code}: ${stderr}`))
      }
    })
    child.stdin.end(input)
  })
}

describe('agent hook spool', () => {
  it('appends each record with one printf write to prevent concurrent field interleaving', () => {
    const spoolLine = buildPosixHookSpoolLines('codex').find((line) =>
      line.includes('>> "$spool_file"')
    )
    expect(spoolLine).toBeDefined()
    expect(spoolLine!.match(/printf/g)).toHaveLength(1)
    expect(spoolLine).toContain('"$spool_now" "$payload"')
  })

  it('can disable durable persistence without changing the fallback call contract', () => {
    expect(buildPosixHookSpoolLines('codex', undefined, 'disabled')).toEqual([
      'spool_hook_event() {',
      '  return 0',
      '}'
    ])
  })

  it('drops torn lines while retaining complete records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    const file = join(dir, 'pane.jsonl')
    writeFileSync(
      file,
      '\n{"paneKey":"tab:1","source":"codex","receivedAt":1,"payload":{}}\n{"paneKey":'
    )
    expect(readSpoolRecords(file, 1)).toHaveLength(1)
  })

  it('waits for a newline before replaying a complete-looking final record', () => {
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
      ingest: (value: SpoolRecord) => ingested.push(value)
    }
    expect(readSpoolRecords(file)).toHaveLength(0)
    expect(drainAgentHookSpool(options)).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(record)

    appendFileSync(file, '\n')
    expect(drainAgentHookSpool(options)).toBe(1)
    expect(ingested).toHaveLength(1)
    expect(readFileSync(file)).toHaveLength(0)
  })

  it('does not let historical empty pane files starve newer records', () => {
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
    drainAgentHookSpool({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (record) => ingested.push(record)
    })
    expect(ingested).toHaveLength(1)
    expect(ingested[0]?.paneKey).toBe('tab:live')
  })

  it('rejects stale launch tokens before ingest and truncates in place', () => {
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
    drainAgentHookSpool({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => launchTokenHash('new')!,
      ingest: (record) => ingested.push(record)
    })
    expect(ingested).toHaveLength(0)
    expect(readFileSync(file)).toHaveLength(0)
    expect(statSync(file).ino).toBe(inode)
  })

  it('ingests a record with the matching launch token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-spool-'))
    const spool = join(dir, 'spool')
    mkdirSync(spool)
    const file = join(spool, 'pane-1.jsonl')
    writeFileSync(
      file,
      `\n${JSON.stringify({ paneKey: 'tab:1', source: 'codex', launchToken: 'same', receivedAt: Date.now(), payload: { state: 'done' } })}\n`
    )
    const ingested: unknown[] = []
    drainAgentHookSpool({
      endpointDir: dir,
      getPersistedLaunchTokenHash: () => launchTokenHash('same')!,
      ingest: (record) => ingested.push(record)
    })
    expect(ingested).toHaveLength(1)
    expect(ingested[0]).toMatchObject({ paneKey: 'tab:1', isReplay: true })
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
      expect(readFileSync(restarted.lastStatusPath!, 'utf8')).not.toContain('isReplay')
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

  it('does not spool Codex payloads when the receiver is unavailable', () => {
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
        ORCA_AGENT_LAUNCH_TOKEN: 'generation-token'
      },
      timeout: 5000
    })
    expect(readdirSync(endpointDir)).toEqual(['endpoint.env'])
  })

  it.skipIf(process.platform === 'win32').each([
    { agent: 'Claude', script: () => getClaudeScript('posix') },
    { agent: 'Codex', script: () => codexInternals.getManagedScript('posix') }
  ])(
    'still delivers $agent payloads to a live loopback receiver without persistence',
    async (entry) => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-spool-live-'))
      const endpointDir = join(dir, 'agent-hooks')
      mkdirSync(endpointDir, { recursive: true })
      const server = createServer()
      let requestTimeout: NodeJS.Timeout | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        const received = new Promise<{ body: string; token: string | undefined }>(
          (resolve, reject) => {
            requestTimeout = setTimeout(
              () => reject(new Error('managed hook did not post')),
              15_000
            )
            server.on('request', (request, response) => {
              const chunks: Buffer[] = []
              request.on('data', (chunk: Buffer) => chunks.push(chunk))
              request.on('end', () => {
                response.statusCode = 204
                response.end()
                const tokenHeader = request.headers['x-orca-agent-hook-token']
                resolve({
                  body: Buffer.concat(chunks).toString('utf8'),
                  token: typeof tokenHeader === 'string' ? tokenHeader : undefined
                })
              })
            })
          }
        )
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('loopback listener did not expose a TCP port')
        }
        const endpoint = join(endpointDir, 'endpoint.fixture')
        writeFileSync(
          endpoint,
          `ORCA_AGENT_HOOK_PORT=${address.port}\nORCA_AGENT_HOOK_TOKEN=synthetic-token\nORCA_AGENT_HOOK_ENV=test\nORCA_AGENT_HOOK_VERSION=1\nORCA_AGENT_HOOK_TRANSPORT=raw-json-v1\n`
        )
        const script = join(dir, 'codex-hook.sh')
        writeFileSync(script, entry.script())
        chmodSync(script, 0o755)
        const payload = '{"hook_event_name":"SubagentStop","agent_id":"synthetic-child"}'
        const [, posted] = await Promise.all([
          runPosixHook(script, `${payload}\n`, {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            ORCA_AGENT_HOOK_ENDPOINT: endpoint,
            ORCA_PANE_KEY: 'tab-live:0',
            ORCA_TAB_ID: 'tab-live',
            ORCA_AGENT_LAUNCH_TOKEN: 'synthetic-generation'
          }),
          received
        ])
        expect(posted).toEqual({ body: payload, token: 'synthetic-token' })
        expect(existsSync(join(endpointDir, 'spool'))).toBe(false)
      } finally {
        if (requestTimeout) {
          clearTimeout(requestTimeout)
        }
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()))
        }
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

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
