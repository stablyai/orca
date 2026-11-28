import type { RexDispatchEvidence } from './rex-fresh-intent'
import { validateRexShutdown } from './rex-fresh-validation'
import { RexOrderedWrites, dispatchRexWrite } from './rex-ordered-writes'
import { rexPowerLifecycle } from './rex-power-lifecycle'
import { observeRexControl } from './rex-wake-probe'
import { RexAttachmentState } from './rex-attachment-state'
import { RexThemeController } from './rex-theme'
import type { TerminalOscColorQueryReplyColors } from '../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import { rm } from 'node:fs/promises'
import type { IPtyProvider, PtySpawnOptions } from '../pty/provider-contract'
import type { PtySpawnResult } from '../pty/spawn-result'
import {
  writeRefused,
  type WriteSettlement
} from '../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { prepareRexFreshSession, type RexFreshSession } from './rex-fresh-session'
import { createRexLaunchPayloadFactory, type RexLaunchPayloadFactory } from './rex-launch-worker'
import { retireRexSession } from './rex-close-block'
import { consumeRexOutput } from './rex-output-consumer'
import { createRexSessionParser } from './rex-session-parser'
import type { RexSessionStore } from './rex-session-store'
import { prepareRexReattach, type RexSnapshotDecoder } from './rex-reattach'
import { rexSnapshotSpawnResult } from './rex-capture-snapshot'

/** Low-level transport adapter; the native contract is implemented by RexPtyProvider. */
export class RexFreshPtyProvider extends RexAttachmentState {
  private readonly writes = new RexOrderedWrites()
  private readonly theme = new RexThemeController()

  constructor(
    protected readonly socketPath: string,
    protected readonly store: RexSessionStore,
    private readonly preparePayload: RexLaunchPayloadFactory = createRexLaunchPayloadFactory()
  ) {
    super()
  }

  async spawn(
    opts: PtySpawnOptions,
    beforeCreate?: (evidence: RexDispatchEvidence) => Promise<void>,
    afterRelease?: (incarnationId: string) => Promise<void>
  ): Promise<PtySpawnResult> {
    if (rexPowerLifecycle.isHeld()) {
      throw new Error('Rex host suspended')
    }
    const { session, tail, nonce, release, discard } = await prepareRexFreshSession(
      this.socketPath,
      opts,
      this.preparePayload,
      beforeCreate,
      this.theme.current()
    )
    this.sessions.set(session.id, session)
    this.observeControl(session)
    void this.consume(session, tail, nonce)
    try {
      if (session.lost) {
        throw new Error('Rex disconnected before launch')
      }
      await this.store.save(session.record)
      await this.theme.apply(session)
      if (session.lost || opts.signal?.aborted) {
        throw new Error('Rex launch lost before gate release')
      }
      await release()
      if (session.lost) {
        throw new Error('Rex disconnected during launch')
      }
      await afterRelease?.(session.record.incarnationId)
    } catch (error) {
      discard()
      await this.retireAttached(session.id, {}).catch((cleanup) => {
        throw new AggregateError([error, cleanup], 'Rex release and cleanup failed')
      })
      throw error
    }
    return {
      id: session.id,
      incarnationId: session.record.incarnationId,
      pid: session.record.rootPid,
      ...(session.exitCode !== undefined ? { exitedBeforeSpawnReply: true as const } : {})
    }
  }

  setColorQueryReplyColors = (colors: TerminalOscColorQueryReplyColors): void =>
    this.theme.update(colors, this.sessions.values())

  private observeControl(session: RexFreshSession): void {
    observeRexControl(session, (retainControl) => this.markLost(session, retainControl))
  }

  protected async restore(
    id: string,
    incarnationId: string,
    decode: RexSnapshotDecoder
  ): Promise<PtySpawnResult> {
    if (this.sessions.has(id) || this.restoring.has(id)) {
      throw new Error('Rex restore not available')
    }
    this.restoring.add(id)
    try {
      const record = await this.store.read(id, incarnationId)
      if (record.adopted || record.backend !== 'rex-local') {
        throw new Error('External Rex record cannot use managed provider')
      }
      await this.store.retirements.assertAvailable(record)
      const { session, snapshot, tail, nonce } = await prepareRexReattach(
        this.socketPath,
        record,
        decode
      )
      try {
        await this.store.retirements.assertAvailable(record)
        await this.store.read(id, incarnationId)
      } catch (error) {
        session.data.close()
        session.control.close()
        throw error
      }
      this.sessions.set(id, session)
      this.pendingRestore.set(id, { tail, nonce, continuation: snapshot.continuation }, () =>
        this.markLost(session, true)
      )
      this.observeControl(session)
      if (session.lost) {
        await this.detach(id)
        throw new Error('Rex disconnected during restore')
      }
      return rexSnapshotSpawnResult(record, snapshot)
    } finally {
      this.restoring.delete(id)
    }
  }

  /** Caller must apply the returned snapshot before releasing live output. */
  activateRestored(id: string): void {
    const session = this.sessions.get(id)
    const pending = this.pendingRestore.get(id)
    if (!session || !pending || session.lost || session.closing) {
      throw new Error('Rex restored stream unavailable')
    }
    this.pendingRestore.delete(id, true)
    void this.consume(session, pending.tail, pending.nonce, pending.continuation)
  }

  private async consume(
    session: RexFreshSession,
    tail: Buffer,
    nonce: bigint,
    continuation?: Buffer
  ): Promise<void> {
    const stream = session.data
    const parser = createRexSessionParser(
      session,
      nonce,
      this.dataCallbacks,
      this.exitCallbacks,
      () => this.onNaturalExit(session)
    )
    try {
      await consumeRexOutput(
        session,
        parser,
        tail,
        continuation,
        () =>
          !session.closing &&
          !session.lost &&
          session.data === stream &&
          !this.restoring.has(session.id)
      )
    } catch {
      if (
        !session.closing &&
        session.data === stream &&
        !this.restoring.has(session.id) &&
        session.exitCode === undefined
      ) {
        this.markLost(session, true)
      }
    }
  }

  protected onNaturalExit(_session: RexFreshSession): void {}

  pauseProducer = (id: string): void => this.sessions.get(id)?.data.pauseDelivery()
  resumeProducer = (id: string): void => this.sessions.get(id)?.data.resumeDelivery()

  protected markLost(session: RexFreshSession, retainControl = false): void {
    if (this.sessions.get(session.id) !== session || session.closing || session.lost) {
      return
    }
    session.lost = true
    this.pendingRestore.delete(session.id)
    session.data.close()
    // A failed data stream does not revoke the client's control-plane ownership.
    // Keep it so a fresh ticket can replace the waiting stream without stealing.
    if (!retainControl) {
      session.control.close()
    }
    this.notifyWriteUnavailable(session.id)
  }

  async writeWithSettlement(id: string, data: string): Promise<WriteSettlement> {
    const session = this.sessions.get(id)
    if (!this.canInteract(session) || session.exitCode !== undefined) {
      return writeRefused('provider_unavailable')
    }
    const bytes = Buffer.byteLength(data)
    if (bytes > 1024 * 1024) {
      return writeRefused('payload_exceeds_transport_limit')
    }
    const stream = session.data
    const generation = rexPowerLifecycle.generation()
    const current = () =>
      this.sessions.get(id) === session &&
      session.data === stream &&
      generation === rexPowerLifecycle.generation() &&
      this.canInteract(session) &&
      session.exitCode === undefined
    return this.writes.submit(session, bytes, current, () =>
      dispatchRexWrite(session, data, () => this.markLost(session), current)
    )
  }

  async getInitialCwd(id: string): Promise<string> {
    const session = this.sessions.get(id)
    if (!session) {
      throw new Error('Unknown Rex PTY')
    }
    return session.cwd
  }

  async shutdown(id: string, opts: Parameters<IPtyProvider['shutdown']>[1] = {}): Promise<void> {
    await this.retireAttached(id, opts)
  }

  private async retireAttached(
    id: string,
    opts: Parameters<IPtyProvider['shutdown']>[1]
  ): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) {
      return
    }
    validateRexShutdown(session, opts)
    session.closing = true
    this.pendingRestore.delete(id)
    session.data.close()
    session.control.close()
    try {
      await retireRexSession(this.socketPath, session.record, this.store, opts.deadlineMs)
      this.sessions.delete(id)
    } finally {
      if (session.gateDir) {
        await rm(session.gateDir, { recursive: true, force: true })
      }
    }
  }
}
