import '../../agent-hooks/server/testing/memory-agent-identity-store.test-fixture'
import type * as WorktreeScanCacheModule from '../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../git/worktrees/catalog/worktree-listing'
import './unused-default-rpc-methods.test-fixture'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../terminal/input/agent-prompt-submission-runtime-test-fixture'
import { UnixSocketTransport } from './unix-socket-transport'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { STATUS_METHODS } from './methods/host-management/status'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import '../orchestration/db/contract-constants'
import '../orchestration/db/messages/mailbox-routing-page'
import '../orchestration/db/dispatch-row-writer'
import '../orchestration/db/attempt-outcome-projection'
import { OrcaRuntimeRpcServer } from './server/runtime-rpc'
import { ORCHESTRATION_METHODS } from './methods/orchestration/orchestration'
import { bindPaneFirst } from '../orca-runtime-tests/bind-first-pane.test-fixture'
import * as inputAdmission from '../terminal/input/terminal-input-admission'
import { writePtyFromRuntimeController } from '../../ipc/pty/runtime/operations'
import { getLocalPtyProvider } from '../../ipc/pty/provider/registry'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { AgentHookServer } from '../../agent-hooks/server/agent-hook-server'

vi.mock('../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const read = async () => [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'prompt',
        isBare: false,
        isMainWorktree: false
      }
    ]
    return { listWorktrees: read, listWorktreesStrict: read }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

it.each([
  'before',
  'after',
  'paired',
  'orchestration',
  'codex-startup',
  'codex-replay',
  'codex-cold-replay'
] as const)(
  'real CLI phone admission and delivery: %s',
  async (boundary) => {
    const disconnect = boundary === 'before' || boundary === 'after'
    const paired = boundary === 'paired'
    const codex = boundary.startsWith('codex-')
    const replay = boundary === 'codex-replay' || boundary === 'codex-cold-replay'
    const hookServer = replay ? new AgentHookServer() : undefined
    await hookServer?.start({ env: 'production' })
    const text = codex ? 'x'.repeat(1_000) : 'first'
    const hookState = createHookListenerState()
    let hook: ReturnType<typeof normalizeHookPayload> = null
    let promptHandle = ''
    let held = true
    let enters = 0
    const latch = () => Promise.withResolvers<void>()
    const [pasted, release, closed, received] = [latch(), latch(), latch(), latch()]
    const root = mkdtempSync(join(tmpdir(), 'orca-prompt-socket-'))
    const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
    const endpoint =
      kind === 'named-pipe' ? `\\\\.\\pipe\\${root.split(/[/\\]/).at(-1)}` : join(root, 'rpc')
    const transport = new UnixSocketTransport({ endpoint, kind })
    vi.spyOn(getLocalPtyProvider(), 'write').mockReturnValue(true)
    const promptAdmission = vi.spyOn(inputAdmission, 'assertTerminalInputAdmitted')
    const rawAdmission = vi.spyOn(inputAdmission, 'createTerminalInputReservation')
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (_host, data) => {
        pasted.resolve()
        if (codex && data === '\r') {
          enters += 1
          held = enters === 1
          hook = normalizeHookPayload(
            hookState,
            'codex',
            {
              paneKey: 'tab-prompt:22222222-2222-4222-8222-222222222222',
              payload: held
                ? {
                    hook_event_name: 'SessionStart',
                    source: 'startup',
                    session_id: '11111111-1111-4111-8111-111111111111'
                  }
                : {
                    hook_event_name: 'UserPromptSubmit',
                    session_id: '11111111-1111-4111-8111-111111111111',
                    turn_id: 'turn-1',
                    prompt: text
                  }
            },
            'production'
          )
          if (hook && hookServer) {
            if (!held || boundary !== 'codex-cold-replay') {
              hookServer.ingestRemote(hook, 'fixture-connection')
            }
            if (held) {
              hookServer.ingestRemote(
                {
                  ...hook,
                  hasExplicitPrompt: true,
                  isReplay: true,
                  payload: {
                    ...hook.payload,
                    state: 'working',
                    prompt: 'old task',
                    sessionBoundary: undefined,
                    mainAgent: { state: 'working', stateStartedAt: 1_000 }
                  }
                },
                'fixture-connection'
              )
            }
          }
        }
      },
      codex ? 'codex' : 'claude',
      (host, id, data) => writePtyFromRuntimeController({ runtime: host }, id, data, 'driving'),
      {
        getAgentStatusSnapshot: () =>
          hookServer
            ? hookServer
                .getStatusSnapshot()
                .map((row) => ({ ...row, terminalHandle: promptHandle }))
            : hook
              ? [
                  {
                    ...hook.payload,
                    paneKey: hook.paneKey,
                    terminalHandle: promptHandle,
                    receivedAt: hook.payload.mainAgent?.stateStartedAt ?? 1_000,
                    stateStartedAt: hook.payload.mainAgent?.stateStartedAt ?? 1_000,
                    connectionId: null
                  }
                ]
              : []
      }
    )
    promptHandle = handle
    if (codex) {
      Object.defineProperty(runtime, 'getPtyWriteHostPlatform', { value: () => 'win32' })
      Object.defineProperty(runtime, 'readCurrentTerminalWaitScreen', {
        value: async () => ({ lines: [], draft: held ? '[Pasted Content 1000 chars]' : undefined })
      })
    }
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const methods = [...STATUS_METHODS, ...TERMINAL_METHODS, ...ORCHESTRATION_METHODS]
    const dispatcher = new RpcDispatcher({ runtime, methods })
    Object.defineProperty(runtime, 'createAgentPromptRenderGate', {
      value: () => ({ arm: () => {}, wait: () => release.promise, dispose: () => {} })
    })
    let sent: RpcRequest | undefined
    const done: Promise<unknown>[] = []
    transport.onMessage((raw, reply, context) => {
      const request: RpcRequest = JSON.parse(raw)
      const prompt = request.method === 'terminal.send'
      if (prompt) {
        sent = request
        received.resolve()
        context!.signal.addEventListener('abort', () => closed.resolve(), { once: true })
      }
      const admission = prompt && boundary === 'before' ? release.promise : Promise.resolve()
      done.push(
        admission.then(async () =>
          reply(
            JSON.stringify(
              await dispatcher.dispatch(request, {
                ...context,
                // Model the UI transport on the accepted-paste/observer-loss row.
                ...(boundary === 'after' ? { caller: { kind: 'desktop' as const } } : {})
              })
            )
          )
        )
      )
    })
    await transport.start()
    const discovery = {
      runtimeId: runtime.getRuntimeId(),
      pid: process.pid,
      startedAt: 1,
      authToken: 'fixture-token',
      transports: [{ kind, endpoint }]
    }
    writeFileSync(join(root, 'orca-runtime.json'), JSON.stringify(discovery))
    const preload = join(root, 'exit-on-input.ts')
    writeFileSync(preload, "process.stdin.once('data', () => process.exit(0))")
    const program = createRequire(resolve('package.json')).resolve('bun/bin/bun.exe')
    const env = {
      ...Object.fromEntries(
        'HOME USERPROFILE APPDATA LOCALAPPDATA XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME ORCA_E2E_HOME_DIR ORCA_E2E_USER_DATA_DIR ORCA_USER_DATA_PATH TEMP TMP TMPDIR CODEX_HOME CLAUDE_CONFIG_DIR'
          .split(' ')
          .map((key) => [key, root])
      ),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot
    }
    let args = ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json']
    if (codex) {
      args.push('--wait-submit', '5')
    }
    if (paired) {
      args = args.filter((arg) => arg !== '--enter')
    }
    if (boundary === 'orchestration') {
      const pane = {
        worktreeId: 'repo-1::/tmp/worktree-a',
        tabId: '11111111-1111-4111-8111-111111111111',
        leafId: '22222222-2222-4222-8222-222222222222',
        ptyId: 'pty-coordinator'
      }
      bindPaneFirst(runtime, pane)
      runtime.registerPty(pane.ptyId, pane.worktreeId, null, pane)
      runtime.registerPreAllocatedHandleForPty(pane.ptyId, 'term_coordinator')
      const run = db.createRun({
        objective: 'phone admission',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: `${pane.tabId}:${pane.leafId}`
      })
      const task = db.createTask({ runId: run.id, spec: 'first' })
      args = [
        'orchestration',
        'dispatch',
        '--from',
        'term_coordinator',
        '--task',
        task.id,
        '--to',
        handle,
        '--inject',
        '--json'
      ]
    }
    const server = paired
      ? new OrcaRuntimeRpcServer({
          runtime,
          methods,
          userDataPath: root,
          enableWebSocket: true,
          wsPort: 0
        })
      : null
    if (server) {
      await server.start()
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'CLI test',
        scope: 'runtime'
      })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      args.push('--pairing-code', offer.pairingUrl)
    }
    if (!disconnect) {
      await runtime.handleMobileSubscribe('pty-prompt', 'phone-A', { cols: 45, rows: 20 })
      release.resolve()
    }
    const command = ['--preload', preload, resolve('src/cli/index.ts'), ...args]
    const child = spawn(program, command, { cwd: root, env, stdio: 'pipe' })
    const exited = once(child, 'close')
    let output = ''
    child.stdout.on('data', (data) => {
      output += data.toString()
    })
    child.stderr.resume()
    try {
      if (!disconnect) {
        child.stdin.end()
        expect((await exited)[0]).toBe(0)
        expect(JSON.parse(output).result).toMatchObject(
          boundary === 'orchestration' ? { injected: true } : { send: { accepted: true } }
        )
        expect(writes).toEqual(
          paired
            ? ['first']
            : codex
              ? [expect.stringContaining(text), '\r', '\r']
              : [expect.stringContaining('first'), '\r']
        )
        if (codex) {
          expect(held).toBe(false)
          expect(JSON.parse(output).result.send.prompt.stages).toContain('turn_started')
        }
        expect(paired ? rawAdmission : promptAdmission).toHaveBeenCalledWith(
          runtime,
          paired ? 'programmatic' : 'pty-prompt',
          codex ? 'programmatic' : undefined
        )
        expect(runtime.getDriver('pty-prompt')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
        return
      }
      await Promise.race([
        received.promise,
        exited.then(() => expect.fail('CLI exited before sending'))
      ])
      await (boundary === 'after' ? pasted.promise : received.promise)
      if (boundary === 'after') {
        await runtime.handleMobileSubscribe('pty-prompt', 'phone-A', { cols: 45, rows: 20 })
      }
      child.stdin.end('exit') // The test-owned child exits itself; no process-tree termination.
      await exited
      await closed.promise
      const secondObserver = new AbortController()
      const second = runtime.sendTerminalAgentPrompt(handle, 'second', {
        inputKind: 'driving',
        observationSignal: secondObserver.signal
      })
      void second.catch(() => undefined)
      secondObserver.abort()
      release.resolve()
      await Promise.all(done)
      await expect(second).rejects.toThrow('request_aborted')
      expect(writes).toEqual(boundary === 'after' ? [expect.stringContaining('first'), '\r'] : [])
      if (boundary === 'after' && sent) {
        const replay = await dispatcher.dispatch(sent, { caller: { kind: 'desktop' } })
        expect(replay).toMatchObject({ ok: true, result: { mutation: { replayed: true } } })
        expect(writes).toHaveLength(2)
      }
    } finally {
      release.resolve()
      if (child.exitCode === null) {
        child.stdin.end('exit')
      }
      await exited
      await server?.stop()
      hookServer?.stop()
      await transport.stop()
      await Promise.allSettled(done)
      db.close()
      vi.restoreAllMocks()
      rmSync(root, { recursive: true, force: true })
    }
  },
  20_000
)
