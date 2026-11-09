import { sameEndpointIdentity } from '../../endpoint/identity/daemon-endpoint-incarnation'
import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import type { HistoryManager } from '../../history/storage/history-manager'
import type { CheckpointSessionQueue } from '../checkpointing/daemon-checkpoint-session-queue'
import type { TerminalHistoryWriterCapture } from '../../history/storage/terminal-history-writer-handoff'

/** A stop disposition belongs to one physical owner and the writer it actually used. */
export class DaemonHistoryRetirement {
  readonly completion: Promise<void>
  readonly persistenceReady: Promise<unknown>
  private readonly capture: TerminalHistoryWriterCapture | undefined
  private resolve!: () => void
  private finishing: Promise<void> | undefined
  private deleting = false
  private readonly holds = new Set<Promise<void>>()
  exited = false

  constructor(
    readonly incarnationId: string,
    private readonly endpoint: DaemonEndpointIdentity,
    private readonly manager: HistoryManager,
    readonly id: string,
    readonly writer: NonNullable<ReturnType<HistoryManager['captureWriter']>>,
    queue: CheckpointSessionQueue,
    private readonly release: () => void
  ) {
    const tail = queue.captureTail(id)
    this.persistenceReady = tail.catch(() => {}).then(() => manager.drainCapturedWriter(id))
    this.capture = manager.identityRoot?.captureWriter(id, writer, this.persistenceReady)
    this.completion = new Promise((resolve) => {
      this.resolve = resolve
    })
  }

  matches(incarnationId: string | undefined, endpoint: DaemonEndpointIdentity | null): boolean {
    return (
      this.incarnationId === incarnationId &&
      !!endpoint &&
      sameEndpointIdentity(this.endpoint, endpoint) &&
      this.manager.captureWriter(this.id) === this.writer
    )
  }

  hold = (): (() => void) => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    this.holds.add(held)
    return () => {
      this.holds.delete(held)
      release()
    }
  }

  removeHistory = (): void => {
    this.deleting = true
  }

  observeExit(): void {
    this.exited = true
    void this.finish(true).catch((error: unknown) =>
      console.warn('[history] preserved writer detach failed', error)
    )
  }

  finish(detach: boolean): Promise<void> {
    this.finishing ??= (async () => {
      try {
        if (detach) {
          await this.persistenceReady
          while (this.holds.size) {
            await Promise.all(this.holds)
          }
          this.manager.settleCapturedWriter(
            this.id,
            this.writer,
            this.deleting && this.capture?.current() === true
          )
        }
        this.capture?.release()
        this.release()
        this.resolve()
      } catch (error) {
        this.finishing = undefined
        throw error
      }
    })()
    return this.finishing
  }
}
