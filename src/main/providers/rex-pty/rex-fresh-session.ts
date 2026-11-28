import type { RexDispatchEvidence } from './rex-fresh-intent'
import { randomUUID } from 'node:crypto'
import { rm, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { PtySpawnOptions } from '../pty/provider-contract'
import { rexThemeColors, resolveRexStartupTheme, type RexThemeColors } from './rex-theme'
import { readRexRootIdentity } from './rex-root-identity'
import { RexControl } from './rex-control'
import { closeUnreleasedRexBlock } from './rex-close-block'
import { RexDataStream } from './rex-data-stream'
import { checkRexSize, validateRexFreshLaunch } from './rex-fresh-validation'
import type { RexLaunchPayloadFactory } from './rex-launch-worker'
import { resolveRexLaunchShell } from './rex-shell-profiles'
import { prepareRexLaunchGate } from './rex-launch-gate'
import {
  mintRexPtyId,
  rexLocalPtyId,
  rexServerIdentity,
  rexSessionRecord,
  type RexSessionRecord
} from './rex-session-record'
import {
  rexCreatedSession,
  rexAttachedSession,
  rexOwnedBlocks,
  rexDataTicket,
  rexTerminalSize,
  rexTerminalProcess
} from './rex-rpc-schema'

export type RexFreshSession = {
  id: string
  sessionId: string
  blockId: string
  clientId: string
  cwd: string
  gateDir?: string
  record: RexSessionRecord
  control: RexControl
  data: RexDataStream
  lost: boolean
  closing: boolean
  exitCode?: number
}

export function rexTerm<T>(
  session: RexFreshSession,
  method: string,
  args: unknown,
  decode: (value: unknown) => T
): Promise<T>
export function rexTerm(session: RexFreshSession, method: string, args?: unknown): Promise<unknown>
export function rexTerm(
  session: RexFreshSession,
  method: string,
  args: unknown = {},
  decode?: (value: unknown) => unknown
): Promise<unknown> {
  const payload = { session_id: session.sessionId, block_id: session.blockId, args }
  const name = `com.superlogical.terminal.${method}`
  return decode ? session.control.call(name, payload, decode) : session.control.call(name, payload)
}

export async function prepareRexFreshSession(
  socketPath: string,
  opts: PtySpawnOptions,
  preparePayload: RexLaunchPayloadFactory,
  beforeCreate?: (evidence: RexDispatchEvidence) => Promise<void>,
  hostColors?: RexThemeColors
): Promise<{
  session: RexFreshSession
  tail: Buffer
  nonce: bigint
  release: () => Promise<void>
  discard: () => void
}> {
  opts = {
    ...opts,
    env: opts.env && { ...opts.env },
    envToDelete: opts.envToDelete && [...opts.envToDelete],
    terminalShellArgs: opts.terminalShellArgs && [...opts.terminalShellArgs],
    startupIngress: opts.startupIngress && structuredClone(opts.startupIngress)
  }
  validateRexFreshLaunch(opts)
  const id = rexLocalPtyId.parse(opts.sessionId ?? mintRexPtyId(opts.worktreeId))
  if (opts.worktreeId && !id.startsWith(`${opts.worktreeId}@@rex-`)) {
    throw new Error('Rex PTY workspace identity mismatch')
  }
  if (opts.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  checkRexSize(opts.cols, opts.rows)
  const cwd = opts.cwd ?? homedir()
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) {
    throw new Error('Invalid Rex cwd')
  }
  const shell = resolveRexLaunchShell(opts.shellOverride)
  const payload = await preparePayload({ ...opts, shellOverride: shell }, cwd)
  if (opts.signal?.aborted) {
    payload.fill(0)
    throw new Error('client_disconnected')
  }
  const gate = await prepareRexLaunchGate(payload)
  const gateDir = gate.directory
  const label = `orca-rex-${randomUUID()}`
  let sessionId: string | undefined
  let createdBlockId: string | undefined
  let control: RexControl | undefined
  let data: RexDataStream | undefined
  try {
    control = await RexControl.connect(socketPath)
    const server = await control.call('server.status', {}, rexServerIdentity.parse)
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    await beforeCreate?.({ server, label })
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const created = await control.call(
      'session.create',
      {
        label,
        initial_windows: [
          {
            layout: {
              block: {
                flavor: 'com.superlogical.terminal.shell',
                options: {
                  shell: 'none',
                  login: false,
                  command: gate.command,
                  cwd,
                  size: { columns: opts.cols, rows: opts.rows },
                  exit: { on_completion: false }
                }
              }
            }
          }
        ]
      },
      rexCreatedSession.parse
    )
    const createdSessionId = created.session_id
    sessionId = createdSessionId
    const blockId = created.initial_windows?.[0]?.block_ids?.[0]
    if (!blockId) {
      throw new Error('Invalid Rex block ID')
    }
    createdBlockId = blockId
    opts.onPtySpawnCommitted?.()
    const attached = await control.call(
      'session.attach',
      { session_id: sessionId },
      rexAttachedSession.parse
    )
    const owned = await control.call(
      'session.own_block',
      { session_id: sessionId, block_ids: [blockId], mode: 'request' },
      rexOwnedBlocks.parse
    )
    if (owned.blocks?.find((block) => block.block_id === blockId)?.owner !== attached.client_id) {
      throw new Error('Rex block ownership unavailable')
    }
    const ticket = await control.call(
      'data.connect',
      {
        session_id: sessionId,
        block_id: blockId,
        data_ref_id: 'terminal',
        subprotocol: 'rex.data.terminal.v1'
      },
      rexDataTicket.parse
    )
    const stream = await RexDataStream.open(socketPath, ticket.ticket)
    data = stream.stream
    const processInfo = await control.call(
      'com.superlogical.terminal.process',
      { session_id: sessionId, block_id: blockId, args: {} },
      rexTerminalProcess.parse
    )
    if (
      !processInfo.child?.pid ||
      !processInfo.child.cwd ||
      processInfo.last_exit ||
      (await realpath(processInfo.child.cwd)) !== (await realpath(cwd))
    ) {
      throw new Error('Rex spawn process identity was not confirmed')
    }
    const rootIdentity = await readRexRootIdentity(processInfo.child.pid)
    if (!rootIdentity) {
      throw new Error('Rex process start identity unavailable')
    }
    const session: RexFreshSession = {
      id,
      record: rexSessionRecord.parse({
        version: 1,
        backend: 'rex-local',
        id,
        incarnationId: randomUUID(),
        sessionId: createdSessionId,
        blockId,
        server,
        rootPid: processInfo.child.pid,
        rootIdentity,
        interactiveShell: true,
        launcherTheme: rexThemeColors(opts.startupIngress?.launcherColors),
        cwd,
        worktreeId: opts.worktreeId,
        paneKey: opts.paneKey
      }),
      sessionId: createdSessionId,
      blockId,
      clientId: attached.client_id,
      cwd,
      gateDir,
      control,
      data,
      lost: false,
      closing: false
    }
    const colors = resolveRexStartupTheme(hostColors, opts.startupIngress)
    if (colors) {
      await rexTerm(session, 'set_theme', colors)
    }
    await rexTerm(session, 'resize', { columns: opts.cols, rows: opts.rows })
    const size = await rexTerm(session, 'size', {}, rexTerminalSize.parse)
    if (size.columns !== opts.cols || size.rows !== opts.rows || size.owner !== session.clientId) {
      throw new Error('Rex grid or ownership not confirmed')
    }
    return {
      session,
      tail: stream.tail,
      nonce: stream.nonce,
      release: gate.release,
      discard: gate.discard
    }
  } catch (error) {
    gate.discard()
    data?.close()
    // A lost create response is not permission to create another session. The gate expires.
    let cleanupError: unknown
    try {
      if (control && sessionId && createdBlockId) {
        await closeUnreleasedRexBlock(control, sessionId, createdBlockId)
      }
    } catch (failure) {
      cleanupError = failure
    } finally {
      control?.close()
    }
    await rm(gateDir, { recursive: true, force: true })
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Rex spawn failed and cleanup was not confirmed'
      )
    }
    throw error
  }
}
