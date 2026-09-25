// SSH host adapter (ticket 17, spec §4 + D5/D8): the third execution-host
// adapter alongside native + WSL. clangd runs ON THE REMOTE SSH host, spawned
// by the relay as a detached daemon child (execution-boundary: the relay owns
// the process; the client owns only transport). This adapter routes LSP stdio
// through the relay `lsp.*` channel instead of a local spawn: `lsp.spawn` /
// `lsp.write` / `lsp.kill` requests, and `lsp.data` / `lsp.stderr` / `lsp.exit`
// client-bound notifications. Path mapping is POSIX-native (the remote clangd
// sees its own filesystem paths); URI mapping reuses the native POSIX rules.
//
// Disconnect semantics (docs/reference/ssh-execution-boundary.md): a transport
// drop (mux disposes with `connection_lost`) fires the process exit handler
// with a CONNECTION_LOST error — the session reads this as `unverifiable`, NEVER
// `exited` (loss of contact is not evidence of process death). Reconnect spawns
// a fresh clangd and replays open documents (spec §6); the host's session
// machinery rebuilds the document table from currently-open docs.
//
// Capability negotiation (docs/reference/remote-wire-compatibility.md): an old
// relay that predates ticket 17 answers `method_not_found` (-32601) for
// `lsp.spawn`. The adapter probes once per target and, on that answer, marks
// SSH LSP unavailable so navigation degrades instead of hanging on every
// request. New `lsp.*` notifications emitted by a new relay are silently
// dropped by an old client (the mux's per-method handler map has no entry) —
// audited: the new client only subscribes after a successful `lsp.spawn`.
import { normalizeNativeFilePath, nativePathToLspUri, lspUriToNativePath } from './uri-mapping'
import { isLspMethodNotFoundError, LSP_RELAY_METHODS } from '../../shared/lsp-relay-channel'
import { getSshLspRelay } from '../ssh/ssh-lsp-relay-registry'
import type {
  LanguageServerHostAdapter,
  LanguageServerProcessLaunch,
  LanguageServerProcessHandle,
  LanguageServerProcessHandlers
} from './language-server-host-adapter'
import type { ClangdLaunchOptions, ClangdVersionGateResult } from './clangd-launch'
import type { CompileDbStrategy, CompileDbStrategyHooks } from './language-server-host-types'
import { createSshCompileDbStrategy } from './compile-db/ssh-compile-db-strategy'
import { resolveSshClangdVersionGate } from './ssh-clangd-version-gate'

/**
 * The verdict for an SSH clangd session whose transport was lost. Execution
 * boundary: loss of contact is `unverifiable`, never `exited`. The session's
 * `died` error carries `.code = 'CONNECTION_LOST'` so callers that phrase a
 * verdict branch on `isSshRequestOutcomeUnverifiable` (ssh-channel-multiplexer)
 * rather than reading the exit as a clean death.
 */
export const SSH_LSP_TRANSPORT_LOST_CODE = 'CONNECTION_LOST'

export class SshLspTransportLostError extends Error {
  readonly code = SSH_LSP_TRANSPORT_LOST_CODE
  constructor(message = 'SSH relay connection lost; clangd session is unverifiable') {
    super(message)
    this.name = 'SshLspTransportLostError'
  }
}

/** True when a clangd-session exit was a transport loss, not a host-acknowledged death. */
export function isSshLspTransportLost(error: unknown): boolean {
  return (
    error instanceof SshLspTransportLostError ||
    (error instanceof Error && (error as { code?: unknown }).code === SSH_LSP_TRANSPORT_LOST_CODE)
  )
}

/**
 * Build the SSH host adapter bound to an SSH target. The adapter is stateless
 * beyond the targetId: it looks the relay mux up in the registry on each
 * `openProcess`, so a reconnect (which re-registers a fresh mux) is picked up
 * by the next session without rebuilding the adapter.
 */
export function createSshHostAdapter(targetId: string): LanguageServerHostAdapter {
  return {
    kind: 'ssh',
    normalizeKey: normalizeNativeFilePath,
    pathToLspUri: nativePathToLspUri,
    lspUriToPath: lspUriToNativePath,
    resolveClangdProgram: () => 'clangd',
    async resolveClangdVersionGate(_program: string): Promise<ClangdVersionGateResult> {
      // Probe the remote clangd over the relay; absent relay → unverifiable,
      // not a hard reject (the user may reconnect).
      return resolveSshClangdVersionGate(targetId)
    },
    async buildLaunch(
      _worktreeRoot: string,
      opts?: ClangdLaunchOptions
    ): Promise<LanguageServerProcessLaunch> {
      // The program/args run on the REMOTE host (spawned by the relay); the
      // cwd is the remote POSIX worktree root. env is omitted — the relay
      // inherits the remote process env, and clangd config comes from the
      // remote filesystem (compile_commands.json + .clangd).
      const args: string[] = []
      const compileCommandsDir = opts?.compileCommandsDir ?? null
      if (compileCommandsDir) {
        args.push(`--compile-commands-dir=${compileCommandsDir}`)
      }
      args.push('--log=info')
      return { program: 'clangd', args, cwd: _worktreeRoot }
    },
    openProcess(
      launch: LanguageServerProcessLaunch,
      handlers: LanguageServerProcessHandlers
    ): LanguageServerProcessHandle {
      return openSshLspProcess(targetId, launch, handlers)
    },
    createDbStrategy(worktreeRoot: string, hooks: CompileDbStrategyHooks): CompileDbStrategy {
      return createSshCompileDbStrategy(targetId, worktreeRoot, hooks)
    }
  }
}

/**
 * Open an LSP process backed by the relay `lsp.*` channel. Resolves the mux
 * from the registry, probes `lsp.spawn` capability, and wires the stdio
 * callbacks to the `lsp.data/stderr/exit` notifications. Transport loss
 * surfaces as `SshLspTransportLostError` (unverifiable).
 */
function openSshLspProcess(
  targetId: string,
  launch: LanguageServerProcessLaunch,
  handlers: LanguageServerProcessHandlers
): LanguageServerProcessHandle {
  const mux = getSshLspRelay(targetId)
  // A missing mux means the SSH relay is not connected — the session must not
  // pretend clangd is alive. Surface as a transport-lost (unverifiable) exit so
  // the host drops the session and the next didOpen retries after reconnect.
  if (!mux || mux.isDisposed()) {
    const error = new SshLspTransportLostError()
    handlers.onExit(error)
    return deadHandle()
  }

  let sessionId: string | null = null
  let exited = false
  let exitReported = false
  /** Buffered writes awaiting the spawn response (the LSP client may send the
   *  initialize frame before `lsp.spawn` resolves). Flushed once the id lands. */
  const pendingWrites: Buffer[] = []
  let resolveExited: (proven: boolean) => void
  const exitedPromise = new Promise<boolean>((resolve) => {
    resolveExited = resolve
  })

  const reportExit = (error: Error | null): void => {
    if (exitReported) {
      return
    }
    exitReported = true
    exited = true
    // Tear down the notification subscriptions so a stale session cannot leak
    // handlers past its lifetime (the mux outlives this handle).
    unsubscribeData()
    unsubscribeStderr()
    unsubscribeExit()
    unsubscribeDispose()
    handlers.onExit(error)
    resolveExited(true)
  }

  // Stdout → handlers.onStdoutChunk. Ack each frame to release the relay's
  // credit window (the relay pauses stdout while unacked >= window).
  const unsubscribeData = mux.onNotificationByMethod(LSP_RELAY_METHODS.data, (params) => {
    if (typeof params.sessionId !== 'string' || params.sessionId !== sessionId) {
      return
    }
    const data = typeof params.data === 'string' ? params.data : ''
    if (data) {
      handlers.onStdoutChunk(Buffer.from(data, 'base64'))
    }
    const seq = typeof params.seq === 'number' ? params.seq : Number(params.seq)
    if (Number.isInteger(seq)) {
      mux.notify(LSP_RELAY_METHODS.ack, { sessionId, seq })
    }
  })

  const unsubscribeStderr = mux.onNotificationByMethod(LSP_RELAY_METHODS.stderr, (params) => {
    if (typeof params.sessionId !== 'string' || params.sessionId !== sessionId) {
      return
    }
    const line = typeof params.line === 'string' ? params.line : ''
    if (line) {
      handlers.onStderrLine(line)
    }
  })

  const unsubscribeExit = mux.onNotificationByMethod(LSP_RELAY_METHODS.exit, (params) => {
    if (typeof params.sessionId !== 'string' || params.sessionId !== sessionId) {
      return
    }
    // Host-acknowledged exit: the relay observed the child terminate. This is
    // positive evidence of death from the owning host — `exited`, not unverifiable.
    const code = typeof params.code === 'number' ? params.code : null
    const signal = typeof params.signal === 'string' ? params.signal : null
    reportExit(
      signal
        ? new Error(`clangd exited signal=${signal}`)
        : code === 0
          ? null
          : new Error(`clangd exited code=${code}`)
    )
  })

  // Transport loss: the mux disposes with `connection_lost`. Per execution
  // boundary, this is `unverifiable` — fire the transport-lost error, NOT a
  // clean exit. The session's reconnect path spawns a fresh clangd + replays.
  const unsubscribeDispose = mux.onDispose((reason) => {
    if (reason === 'connection_lost') {
      reportExit(new SshLspTransportLostError())
    } else if (!exited) {
      // A graceful shutdown (relay quit) detaches; treat as unverifiable too,
      // since the child's fate on the host is unknown from here.
      reportExit(
        new SshLspTransportLostError('SSH relay shut down; clangd session is unverifiable')
      )
    }
  })

  // Spawn is async; the handle is returned synchronously and the spawn promise
  // drives the session start. A method_not_found answer (old relay) degrades.
  // The promise is awaited implicitly — its result sets `sessionId` and flushes
  // buffered writes; a rejection routes through `reportExit`.
  void mux
    .request(LSP_RELAY_METHODS.spawn, {
      program: launch.program,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env
    })
    .then((result) => {
      const id = (result as { sessionId?: string } | null)?.sessionId
      if (typeof id !== 'string' || !id) {
        throw new Error('lsp.spawn returned no sessionId')
      }
      sessionId = id
      // Flush any writes buffered while the spawn was in flight (the LSP client's
      // initialize frame may have been written before the id resolved).
      for (const buffered of pendingWrites.splice(0)) {
        mux.notify(LSP_RELAY_METHODS.write, {
          sessionId,
          data: buffered.toString('base64')
        })
      }
      return id
    })
    .catch((error) => {
      if (isLspMethodNotFoundError(error)) {
        // Old relay: the whole `lsp.*` family is absent. Degrade — do not
        // retry every navigation request. The error message is user-facing.
        reportExit(
          Object.assign(
            new Error(
              'SSH relay does not support LSP navigation (relay too old). Update Orca on the remote host.'
            ),
            { code: 'LSP_METHOD_NOT_FOUND' }
          )
        )
        return null
      }
      reportExit(error instanceof Error ? error : new Error(String(error)))
      return null
    })

  return {
    get pid(): number | undefined {
      // The pid is on the remote host; not exposed to the client.
      return undefined
    },
    exited: exitedPromise,
    write(bytes: Buffer): void {
      if (exited) {
        return
      }
      // Buffer until the session id resolves; the LSP client can send the
      // initialize frame before `lsp.spawn` returns. The client paces its own
      // writes (small JSON-RPC frames), so no credit window is needed here.
      if (!sessionId) {
        pendingWrites.push(bytes)
        return
      }
      mux.notify(LSP_RELAY_METHODS.write, {
        sessionId,
        data: bytes.toString('base64')
      })
    },
    endStdin(): void {
      // The relay owns the remote stdin pipe; the client has no direct handle
      // to close. The shutdown ladder (lsp.kill) is the authoritative stop.
    },
    async killTree(): Promise<boolean> {
      if (!sessionId || exited) {
        return true
      }
      const id = sessionId
      try {
        await mux.request(LSP_RELAY_METHODS.kill, { sessionId: id })
      } catch (error) {
        // A transport loss during kill is unverifiable, not a kill failure —
        // the child's fate on the host is unknown. Surface the exit regardless.
        if (!isLspMethodNotFoundError(error)) {
          reportExit(new SshLspTransportLostError())
        }
      }
      return true
    }
  }

  function deadHandle(): LanguageServerProcessHandle {
    return {
      pid: undefined,
      exited: Promise.resolve(true),
      write: () => {},
      endStdin: () => {},
      killTree: async () => true
    }
  }
}
