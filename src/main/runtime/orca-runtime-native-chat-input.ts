import { OrcaRuntimeWithAgentExitChatView } from './orca-runtime-agent-exit-chat-view'
import { NativeChatInputGuard, type NativeChatTargetObservation } from './native-chat-input-guard'
import { readHeadlessNativeChatTarget } from './headless-native-chat-target-read'
import type { RuntimeTerminalSend } from '../../shared/runtime-types'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import type {
  RuntimeChatInputWriteResult,
  RuntimeTerminalWriteOptions
} from './runtime-terminal-writer'

/**
 * Chat composer writes, admitted chunk by chunk from the committed presentation and settled by the
 * transport. Narrow guard: a pane that may show chat admits writes; it does not prove a live agent.
 */
export class OrcaRuntimeWithNativeChatInput extends OrcaRuntimeWithAgentExitChatView {
  protected readonly nativeChatInputGuard = new NativeChatInputGuard()
  private readonly localChatInputTailByPtyId = new Map<string, Promise<unknown>>()

  onPtyExit(...args: Parameters<OrcaRuntimeWithAgentExitChatView['onPtyExit']>) {
    const result = super.onPtyExit(...args)
    this.nativeChatInputGuard.forget(args[0])
    return result
  }

  /**
   * What the tab's owner holds now: the renderer that owns a desktop host's tabs (asked per chunk,
   * never a published snapshot), or the headless host's persistence read without awaiting.
   */
  protected async readNativeChatTarget(ptyId: string): Promise<NativeChatTargetObservation> {
    if (this.getAvailableAuthoritativeWindow()) {
      const read = this.notifier?.readNativeChatTarget
      if (!read) {
        return 'unverifiable'
      }
      try {
        return await read.call(this.notifier, ptyId)
      } catch (error) {
        // Why admit: an unreadable renderer is not an exit; narrow policy keeps today's writes.
        console.warn('[native-chat] chat target unreadable; composer write left unguarded', error)
        return 'unverifiable'
      }
    }
    const worktreeId = this.ptysById.get(ptyId)?.worktreeId
    return worktreeId
      ? readHeadlessNativeChatTarget(
          this.getWorkspaceSessionForWorktree(worktreeId),
          worktreeId,
          ptyId,
          (tabId) => this.headlessPresentationStamps.token(worktreeId, tabId, ptyId)
        )
      : { kind: 'unknown-target' }
  }

  private async admitNativeChatInput(
    ptyId: string,
    actionId: string
  ): Promise<'admitted' | 'refused'> {
    const target = await this.readNativeChatTarget(ptyId)
    // Why after the read: the PTY may have been replaced while the renderer answered.
    return this.nativeChatInputGuard.admit(
      ptyId,
      this.ptysById.get(ptyId)?.incarnationId ?? null,
      actionId,
      target
    )
  }

  /** A tagged chat write through `terminal.send`; refused writes never fall back to raw input. */
  protected async writeNativeChatInputAction(
    handle: string,
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options: RuntimeTerminalWriteOptions & { chatInput: { actionId: string } },
    prepare?: () => Promise<void>
  ): Promise<RuntimeTerminalSend> {
    const result = await this.enqueueNativeChatInput(ptyId, async () => {
      await prepare?.()
      return this.terminalWriter.writeChatInputAction(ptyId, action, {
        ...options,
        admit: () => this.admitNativeChatInput(ptyId, options.chatInput.actionId)
      })
    })
    return { handle, ...result }
  }

  /** The local desktop composer's write: the same guard and settled writer as `terminal.send`. */
  writeNativeChatInputToPty(
    ptyId: string,
    data: string,
    inputKind: TerminalInputKind,
    actionId: string,
    beforeWrite?: () => Promise<boolean>
  ): Promise<RuntimeChatInputWriteResult> {
    return this.enqueueNativeChatInput(ptyId, async () => {
      // Why inside the queue: a body's viewport/size wait must never let its Enter overtake it.
      if (beforeWrite && !(await beforeWrite())) {
        return { accepted: false, bytesWritten: 0 }
      }
      return this.terminalWriter.writeChatInputAction(
        ptyId,
        { text: data },
        { inputKind, admit: () => this.admitNativeChatInput(ptyId, actionId) }
      )
    })
  }

  /** One ordered lane per PTY for every chat write, entered before any of its own waits. */
  protected enqueueNativeChatInput<T>(ptyId: string, write: () => Promise<T>): Promise<T> {
    const previous = this.localChatInputTailByPtyId.get(ptyId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(write)
    this.localChatInputTailByPtyId.set(ptyId, next)
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.localChatInputTailByPtyId.get(ptyId) === next) {
          this.localChatInputTailByPtyId.delete(ptyId)
        }
      })
    return next
  }
}
