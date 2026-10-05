import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { DaemonServer } from '../daemon/daemon-server'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { getDaemonSocketPath } from '../daemon/daemon-spawner'
import { createPtySubprocess } from '../daemon/pty-subprocess'
import { inspectPtyProviderProcess } from '../providers/pty-process-inspection'
import { AgentHookServer } from '../agent-hooks/server'
import { buildHookProcessCapture } from '../agent-hooks/hook-process-capture'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import { buildBody, postHookEvent } from '../agent-hooks/server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const A = HEADLESS_LEAF_ID
const WT = TEST_WORKTREE_ID
const PANE_KEY = `host-tab:${A}`
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup()
    } catch (error) {
      console.warn('[f2r-daemon-test] cleanup failed', error)
    }
  }
  vi.unstubAllEnvs()
})

let debugOutput: string[] = []
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(debugOutput.join(''))}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Harmless node stand-ins whose argv the production recognizer reads as Claude / Codex. */
function writeStandIns(bin: string): void {
  const node = process.execPath
  const capture = JSON.stringify(buildHookProcessCapture().join('\n'))
  writeFileSync(
    join(bin, 'claude'),
    `#!${node}
const fs = require('fs')
const { execFileSync } = require('child_process')
const dir = process.env.STANDIN_DIR
// The exact process capture Orca's managed Claude hook runs, aimed at this process.
const identity = execFileSync('/bin/sh', ['-c', ${capture} + '\\nprintf "%s" "$orca_agent_process"'], {
  env: { ...process.env, ORCA_HOOK_AGENT_PID: String(process.pid), ORCA_PANE_KEY: 'pane' },
  encoding: 'utf8'
})
fs.writeFileSync(dir + '/claude.pid', String(process.pid))
fs.writeFileSync(dir + '/claude.identity', identity)
let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk
  if (!input.includes('/exit')) return
  fs.writeFileSync(dir + '/claude.exiting', '')
  // Claude runs its SessionEnd hook before the process leaves; wait for the test to send it.
  const wait = setInterval(() => {
    if (fs.existsSync(dir + '/claude.ack')) { clearInterval(wait); process.exit(0) }
  }, 20)
})
`
  )
  writeFileSync(
    join(bin, 'codex'),
    `#!${node}
const fs = require('fs')
fs.writeFileSync(process.env.STANDIN_DIR + '/codex.started', String(process.pid))
let input = ''
// Codex quits on its own input path; it has no process-ending hook.
process.stdin.on('data', (chunk) => { input += chunk; if (input.includes('q')) process.exit(0) })
`
  )
  chmodSync(join(bin, 'claude'), 0o755)
  chmodSync(join(bin, 'codex'), 0o755)
}

async function startDefaultDaemonHost(tab: {
  viewMode?: 'chat'
  launchAgent?: 'claude' | 'codex'
}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-f2r-daemon-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  const bin = join(dir, 'bin')
  for (const path of [home, bin, join(dir, 'claude-config'), join(dir, 'codex-home')]) {
    mkdirSync(path, { recursive: true })
  }
  // Why: nothing spawned here may read or write the real ~/.claude or ~/.codex.
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'claude-config'))
  vi.stubEnv('CODEX_HOME', join(dir, 'codex-home'))
  vi.stubEnv('ZDOTDIR', home)
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'))
  writeStandIns(bin)

  const server = new DaemonServer({
    socketPath: getDaemonSocketPath(dir),
    tokenPath: join(dir, 'daemon.token'),
    log: { log: () => {}, close: () => {} },
    // Production spawn: a normal node-pty session (no spawn-file child evidence).
    spawnSubprocess: (opts) => createPtySubprocess(opts)
  })
  await server.start()
  cleanups.push(() => server.shutdown())
  const adapter = new DaemonPtyAdapter({
    socketPath: getDaemonSocketPath(dir),
    tokenPath: join(dir, 'daemon.token'),
    historyPath: join(dir, 'history')
  })
  cleanups.push(() => adapter.dispose())

  const spawned = await adapter.spawn({
    cols: 100,
    rows: 30,
    cwd: home,
    shellOverride: '/bin/sh',
    // Why no login shell: a login profile (macOS path_helper) can put a real agent CLI on PATH.
    terminalShellArgs: [],
    sessionId: `f2r-${tab.launchAgent ?? 'claude'}-${process.pid}`,
    env: {
      HOME: home,
      PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
      CODEX_HOME: join(dir, 'codex-home'),
      STANDIN_DIR: dir,
      PS1: '$ '
    }
  })
  cleanups.push(() => adapter.shutdown(spawned.id, { immediate: true }))

  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const session = {
    ...base,
    tabsByWorktree: {
      [WT]: [
        {
          ...base.tabsByWorktree[WT]![0]!,
          ptyId: spawned.id,
          ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {})
        }
      ]
    },
    unifiedTabs: {
      [WT]: [
        {
          id: 'host-tab',
          entityId: 'host-tab',
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'terminal' as const,
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ...(tab.viewMode ? { viewMode: tab.viewMode } : {})
        }
      ]
    },
    terminalLayoutsByTabId: { 'host-tab': makeHeadlessTerminalLayout({ [A]: spawned.id }) }
  }
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture implements RuntimeStore; its annotation erases the Vitest mock call signatures.
  const store = runtimeStore as RuntimeStore
  const hooks = new AgentHookServer()
  await hooks.start({ env: 'production', userDataPath: join(dir, 'user-data') })
  cleanups.push(() => hooks.stop())
  const runtime = new OrcaRuntimeService(store, undefined, {
    checkHookAgentPresence: (paneKey) => hooks.checkAgentPresence(paneKey)
  })
  cleanups.push(installHookStatusSessionTabsRepublish(hooks, () => runtime))
  const inspections: unknown[] = []
  runtime.setPtyController({
    write: (id, data) => adapter.write(id, data),
    writeWithSettlement: (id, data) => adapter.writeWithSettlement(id, data),
    kill: (id) => {
      void adapter.shutdown(id, { immediate: true })
      return true
    },
    getForegroundProcess: (id) => adapter.getForegroundProcess(id),
    // The production provider path the runtime controller uses for a daemon-backed PTY.
    inspectProcess: async (id, options) => {
      const inspection = await inspectPtyProviderProcess(adapter, id, options)
      inspections.push(inspection)
      return inspection
    }
  })
  runtime.registerPty(spawned.id, WT, null, {
    tabId: 'host-tab',
    leafId: A,
    ...(spawned.incarnationId ? { incarnationId: spawned.incarnationId } : {})
  })
  const output: string[] = []
  const unsubscribe = adapter.onData(({ id, data }) => {
    if (id === spawned.id) {
      output.push(data)
      runtime.onPtyData(id, data, Date.now())
    }
  })
  cleanups.push(unsubscribe)
  debugOutput = output
  await runtime.listMobileSessionTabs(`id:${WT}`)
  // Guard: this shell must not be able to reach a real agent CLI by name, whatever is typed.
  // Why printf with %s: the markers then never appear in the shell's echo of the command line.
  adapter.write(
    spawned.id,
    "printf 'P%s=%s\\n' ATH \"$PATH\"; command -v claude || printf 'NO_%s\\n' CLAUDE; command -v codex || printf 'NO_%s\\n' CODEX\r"
  )
  await waitUntil(() => output.join('').includes('NO_CODEX'), 10_000, 'the PATH guard')
  const guard = output.join('')
  const shellPath = /PATH=([^\r\n]*)/.exec(guard)?.[1] ?? ''
  expect(shellPath.startsWith('/usr/bin:/bin')).toBe(true)
  expect(shellPath).not.toMatch(/\.local\/bin|homebrew|\/usr\/local\/bin|\.npm|\.bun/)
  expect(guard).toContain('NO_CLAUDE')
  const handle = (): string => runtime['handleByPtyId'].get(spawned.id)!
  return {
    dir,
    // Why absolute: a login shell rebuilds PATH, so a bare agent name could run the real CLI.
    standIn: (name: 'claude' | 'codex') => join(bin, name),
    adapter,
    hooks,
    runtime,
    inspections,
    ptyId: spawned.id,
    tabRow: () => getSession().tabsByWorktree[WT]?.[0],
    viewMode: () => getSession().unifiedTabs?.[WT]?.[0]?.viewMode,
    post: (
      path: '/hook/claude' | '/hook/codex',
      payload: Record<string, unknown>,
      agentProcess?: string
    ) =>
      postHookEvent(
        hooks,
        buildBody(payload, {
          paneKey: PANE_KEY,
          tabId: 'host-tab',
          worktreeId: WT,
          ...(agentProcess ? { agentProcess } : {})
        }),
        path
      ),
    taggedCanary: (actionId: string) =>
      runtime.sendTerminal(
        handle(),
        { text: `touch ${join(dir, 'canary')}`, enter: true },
        { inputKind: 'driving', chatInput: { actionId } }
      ),
    rawShell: (text: string) =>
      runtime.sendTerminal(handle(), { text, enter: true }, { inputKind: 'driving' })
  }
}

async function expectShellAliveAndCanaryRefused(
  host: Awaited<ReturnType<typeof startDefaultDaemonHost>>
) {
  await expect(host.taggedCanary('stale-composer-send')).resolves.toMatchObject({
    accepted: false,
    bytesWritten: 0
  })
  await host.rawShell(`touch ${join(host.dir, 'alive')}`)
  await waitUntil(() => existsSync(join(host.dir, 'alive')), 5_000, 'the shell to run raw input')
  expect(existsSync(join(host.dir, 'canary'))).toBe(false)
}

describeOnPosix('F2 on the default local daemon (real node-pty, production inspection)', () => {
  it('a Claude-style /exit with its real SessionEnd hook turns an explicit chat tab terminal', async () => {
    const host = await startDefaultDaemonHost({ viewMode: 'chat', launchAgent: 'claude' })
    host.adapter.write(host.ptyId, `${host.standIn('claude')}\r`)
    await waitUntil(() => existsSync(join(host.dir, 'claude.identity')), 10_000, 'claude start')
    const identity = readFileSync(join(host.dir, 'claude.identity'), 'utf8')
    expect(JSON.parse(identity)).toMatchObject({ platform: process.platform })
    const start = { hook_event_name: 'SessionStart', session_id: 'cs-1', source: 'startup' }
    expect((await host.post('/hook/claude', start, identity)).status).toBe(204)

    host.adapter.write(host.ptyId, '/exit\r')
    await waitUntil(() => existsSync(join(host.dir, 'claude.exiting')), 5_000, 'claude /exit')
    const end = { hook_event_name: 'SessionEnd', session_id: 'cs-1', reason: 'prompt_input_exit' }
    expect((await host.post('/hook/claude', end, identity)).status).toBe(204)
    writeFileSync(join(host.dir, 'claude.ack'), '')

    await waitUntil(() => host.viewMode() === 'terminal', 25_000, 'the host to retire chat')
    expect(host.tabRow()?.launchAgent).toBeUndefined()
    // The production daemon answer carries fenced evidence and no shell-child verdict.
    expect(host.inspections.at(-1)).toMatchObject({
      foregroundProcessEvidence: { verdict: 'live', fence: { platform: 'posix' } }
    })
    expect(host.inspections.at(-1)).not.toHaveProperty('childProcessEvidence')
    await expectShellAliveAndCanaryRefused(host)
  }, 60_000)

  it('a Codex-style exit with no process-ending hook retires an unswitched tab by its measured PID', async () => {
    const host = await startDefaultDaemonHost({ launchAgent: 'codex' })
    host.adapter.write(host.ptyId, `${host.standIn('codex')}\r`)
    await waitUntil(() => existsSync(join(host.dir, 'codex.started')), 10_000, 'codex start')
    const pid = Number(readFileSync(join(host.dir, 'codex.started'), 'utf8'))
    const start = { hook_event_name: 'SessionStart', session_id: 'cx-1' }
    expect((await host.post('/hook/codex', start)).status).toBe(204)
    // Let the host measure the running agent (observable as its own fenced capture of the PID).
    await waitUntil(
      () =>
        host.inspections.some(
          (inspection) =>
            JSON.stringify(inspection).includes(`"pid":${pid},`) ||
            JSON.stringify(inspection).includes(`"pid":${pid}}`)
        ),
      10_000,
      'a fenced capture of the codex stand-in'
    ).catch(() => {})
    host.adapter.write(host.ptyId, 'q\r')
    await waitUntil(() => host.tabRow()?.launchAgent === undefined, 25_000, 'hint retirement')
    // Unswitched stays unswitched; the cleared hint is what turns the phone to terminal.
    expect(host.viewMode()).toBeUndefined()
    // The proof used the production daemon's fenced capture of the stand-in itself.
    expect(host.inspections).toContainEqual(
      expect.objectContaining({
        foregroundProcessEvidence: expect.objectContaining({
          verdict: 'live',
          processName: 'codex',
          fence: expect.objectContaining({ process: expect.objectContaining({ pid }) })
        })
      })
    )
    await expectShellAliveAndCanaryRefused(host)
  }, 60_000)
})
