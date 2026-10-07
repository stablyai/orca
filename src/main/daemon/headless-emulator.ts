import './xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { ImageAddon } from '@xterm/addon-image'
import { createHeadlessImageAddon } from './headless-image-addon'
import { prepareHeadlessModelCheckpoint } from './headless-model-checkpoint-restore'
import {
  captureHeadlessModelCheckpoint,
  copyHeadlessModelConfiguration,
  type HeadlessModelConfiguration,
  type HeadlessModelCheckpoint
} from './headless-model-checkpoint'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'
import { advancePartialEscapeTail } from '../../shared/terminal-partial-escape-tail'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import { TerminalOscCwdTitleScanner } from './terminal-osc-cwd-title-scanner'
import {
  installTerminalViewAttributeResponder,
  type TerminalViewAttributeResponder
} from './terminal-view-attribute-responder'
import { installDeviceAttributesResponder } from './startup-device-attributes-responder'
import type { TerminalSnapshot } from './types'
import { captureHeadlessTerminalSnapshot } from './headless-terminal-snapshot-capture'
import { submitHeadlessTerminalWrite } from './headless-terminal-write-submission'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import {
  isTerminalCursorOnEmptyPromptLine,
  readTerminalCursorLineContext
} from '../../shared/terminal-cursor-line-context'

export type HeadlessEmulatorOptions = HeadlessModelConfiguration & {
  /** Query reply sink (terminal-query-authority.md); only `forwardQueryReplies` writes emit here. The daemon Session must never pass this. */
  onQueryReply?: (reply: string) => void
}

export type HeadlessEmulatorWriteOptions = {
  /** Reply ownership for this exact chunk; default false so seed/hydration/snapshot writes never forward (main-side replay guard; twin of renderer replay-guard.ts). */
  forwardQueryReplies?: boolean
}

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
  }
}

// Keep in sync with the renderer twin terminal-capability-replies.ts (main must not import renderer modules).
const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'

export class HeadlessEmulator {
  protected terminal: Terminal
  protected serializer: SerializeAddon
  protected imageAddon: ImageAddon | undefined
  private readonly configuration: HeadlessModelConfiguration
  private pendingWrites = 0
  private oscText: TerminalOscCwdTitleScanner
  private restoredOscLinks: TerminalOscLinkRange[] = []
  private disposed = false
  private onQueryReply: ((reply: string) => void) | null
  private conptyDa1OverrideInstalled = false
  private viewAttributeResponder: TerminalViewAttributeResponder | null = null
  // Why: replies must be scoped to the exact write that carried the query, so seeds/snapshots and unsolicited emissions never leak to the PTY.
  private queryReplyForwardingDepth = 0
  // Why: a mid-escape chunk tail lives in xterm's parser, not the buffer, so serialize() drops it and it renders literal after restore (Bug E).
  private partialEscapeTail = ''

  constructor(opts: HeadlessEmulatorOptions) {
    this.configuration = copyHeadlessModelConfiguration(opts)
    this.oscText = new TerminalOscCwdTitleScanner({
      pathFlavor: opts.pathFlavor,
      remotePosixAuthority: opts.remotePosixFileUriAuthority === true,
      wslDistro: opts.wslDistro
    })
    this.terminal = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: this.configuration.scrollback,
      allowProposedApi: true,
      logLevel: 'off',
      // Why: parse CSI =/>/< u pushes so CSI ? u answers with the flags the hidden app pushed (renderer parity).
      vtExtensions: { kittyKeyboard: true }
    })

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)

    // Why Unicode 11: must match the renderer's char-width measurement, else emoji rows mismeasure and the mirror accumulates cell-shifted tears.
    this.terminal.loadAddon(new Unicode11Addon())
    activateOrcaTerminalUnicodeProvider(this.terminal)

    if (this.configuration.images) {
      this.imageAddon = createHeadlessImageAddon(this.configuration.images)
      this.terminal.loadAddon(this.imageAddon)
    }

    // Why gated: an emulator query reply would beat the renderer's to the shell's stdin (OSC 11 default-black was the casualty).
    this.onQueryReply = opts.onQueryReply ?? null
    if (this.onQueryReply) {
      this.terminal.onData((reply) => this.emitQueryReply(reply))
    }
  }

  /** ConPTY 1.22+ blocks at spawn awaiting a DA1 reply. See startup-device-attributes-responder. */
  installConptyPrimaryDeviceAttributesOverride(): void {
    // Why idempotent: installed at creation and again at spawn-mark time (which can land later), so it's never stacked.
    if (this.conptyDa1OverrideInstalled) {
      return
    }
    this.conptyDa1OverrideInstalled = true
    installDeviceAttributesResponder({
      parser: this.terminal.parser,
      response: CONPTY_DA1_RESPONSE,
      reply: (data) => this.emitQueryReply(data)
    })
  }

  /** Why exposed: responder modules install handlers here (see the view-attribute and
   *  device-attributes responders); the caller owns disposal. */
  get responderParser(): Terminal['parser'] {
    return this.terminal.parser
  }

  /** Headless core has no theme service, so OSC 4/10/11/12 and DSR ?996n answer from the renderer's pushed attributes; daemon Session must never call this. */
  installViewAttributeResponder(getBaseAttributes: () => TerminalViewAttributes | null): void {
    if (this.viewAttributeResponder) {
      return
    }
    this.viewAttributeResponder = installTerminalViewAttributeResponder({
      parser: this.terminal.parser,
      getBaseAttributes,
      // emitQueryReply keeps replies in the per-chunk forwarding window, so seeded/replayed queries answer no one.
      emitReply: (reply) => this.emitQueryReply(reply)
    })
  }

  /** Sets cursor options so xterm answers DECSCUSR / DECRQM 12 renderer-true; per-PTY color overrides are dropped (a theme apply overwrites them anyway). */
  applyPushedViewAttributes(attributes: TerminalViewAttributes): void {
    if (this.disposed) {
      return
    }
    this.terminal.options.cursorStyle = attributes.cursorStyle
    this.terminal.options.cursorBlink = attributes.cursorBlink
    this.viewAttributeResponder?.clearColorOverrides()
  }

  /** Re-seeds snapshot kitty flags via the live-push parse, routed unflagged so it can never answer a query (terminal-query-authority.md). */
  applyKittyKeyboardFlags(flags: number): Promise<void> {
    if (!Number.isInteger(flags) || flags <= 0) {
      return Promise.resolve()
    }
    return this.write(`\x1b[=${flags};1u`)
  }

  private emitQueryReply(reply: string): void {
    if (this.queryReplyForwardingDepth > 0 && this.onQueryReply) {
      this.onQueryReply(reply)
    }
  }

  /** Severs the reply sink so a post-dispose reply can't reach a successor PTY (respawns reuse session ids). */
  disableQueryReplyForwarding(): void {
    this.onQueryReply = null
  }

  write(data: string, opts: HeadlessEmulatorWriteOptions = {}): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }

    const forwardQueryReplies = opts.forwardQueryReplies === true
    if (this.tryWriteSync(data, { forwardQueryReplies })) {
      return Promise.resolve()
    }
    this.oscText.scan(data)
    this.pendingWrites += 1
    return submitHeadlessTerminalWrite(this.terminal, data, {
      enterReplyWindow: forwardQueryReplies
        ? () => {
            this.queryReplyForwardingDepth += 1
          }
        : undefined,
      leaveReplyWindow: forwardQueryReplies
        ? () => {
            this.queryReplyForwardingDepth -= 1
          }
        : undefined,
      parsed: () => {
        this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
      },
      settled: () => {
        this.pendingWrites -= 1
      }
    })
  }

  /** Synchronous write for cold-restore replay (async would snapshot a half-applied stream); false when writeSync is unavailable. */
  writeSync(data: string): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryWriteSync(data)
  }

  private tryWriteSync(data: string, opts: HeadlessEmulatorWriteOptions = {}): boolean {
    if (this.pendingWrites > 0) {
      return false
    }
    const writeSync = (this.terminal as TerminalWithSynchronousWrite)._core?.writeSync
    if (typeof writeSync !== 'function') {
      return false
    }
    this.oscText.scan(data)
    const forwardQueryReplies = opts.forwardQueryReplies === true
    if (forwardQueryReplies) {
      this.queryReplyForwardingDepth += 1
    }
    // Why: restore snapshots are requested right after PTY bursts; queued writes could snapshot half-cleared TUI rows.
    try {
      writeSync.call((this.terminal as TerminalWithSynchronousWrite)._core, data)
    } finally {
      if (forwardQueryReplies) {
        this.queryReplyForwardingDepth -= 1
      }
    }
    this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
    return true
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return
    }
    // Why gated: restored OSC-8 ranges are row-indexed, so a reflow
    // invalidates them — but a resize to the size already applied is not a
    // reflow. Cold restore seeds the ranges and then replays records that
    // resize, and same-size records reach the durable log because every
    // attach re-asserts the pane's dimensions, so clearing unconditionally
    // dropped the links a restore had just recovered.
    if (this.terminal.cols === cols && this.terminal.rows === rows) {
      return
    }
    this.restoredOscLinks = []
    this.terminal.resize(cols, rows)
  }

  // Why: these dims proxy the child's real size, so they stay stale on a dropped resize the renderer must detect.
  getAppliedSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    return captureHeadlessTerminalSnapshot(this.terminal, this.serializer, opts, {
      cwd: this.oscText.cwd,
      lastTitle: this.oscText.lastTitle,
      partialEscapeTail: this.partialEscapeTail,
      restoredOscLinks: this.restoredOscLinks
    })
  }

  captureModelCheckpoint(maxBytes: number): HeadlessModelCheckpoint {
    if (this.disposed) {
      throw new Error('Headless terminal is disposed')
    }
    if (this.pendingWrites > 0) {
      throw new Error('Terminal writes must drain before checkpoint capture')
    }
    if (!this.imageAddon) {
      throw new Error('Headless terminal image support is not configured')
    }
    return captureHeadlessModelCheckpoint(
      {
        ...this.configuration,
        scrollback: this.terminal.options.scrollback
      },
      this.getSnapshot(),
      this.imageAddon,
      maxBytes
    )
  }

  static prepareModelCheckpoint(
    checkpoint: HeadlessModelCheckpoint,
    options: { onQueryReply?: (reply: string) => void; isCurrent?: () => boolean } = {}
  ): Promise<HeadlessEmulator> {
    return prepareHeadlessModelCheckpoint(
      checkpoint,
      (configuration) => new this({ ...configuration, onQueryReply: options.onQueryReply }),
      (model) => model.imageAddon,
      options
    )
  }

  get isAlternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate'
  }

  /** Dangling incomplete escape at the stream position; handoffs seed the other side so a split sequence isn't lost. */
  get partialEscapeTailAnsi(): string {
    return this.partialEscapeTail
  }

  /** PSReadLine's Ctrl+L repaint is only safe at an empty prompt; '>>' is PowerShell's continuation prompt, not empty. */
  isCursorOnEmptyPromptLine(): boolean {
    return isTerminalCursorOnEmptyPromptLine(this.terminal)
  }

  getVisibleLines(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let row = buffer.viewportY; row < buffer.viewportY + this.terminal.rows; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines
  }

  getVisibleBufferRange(): { start: number; endExclusive: number; totalLength: number } {
    const buffer = this.terminal.buffer.active
    const start = buffer.viewportY
    return {
      start,
      endExclusive: Math.min(buffer.length, start + this.terminal.rows),
      totalLength: buffer.length
    }
  }

  getCursorLineContext(rowsAbove = this.terminal.rows): TerminalCursorContext | null {
    return readTerminalCursorLineContext(this.terminal, rowsAbove)
  }

  getBufferTailLines(limit: number): string[] {
    const buffer = this.terminal.buffer.active
    const start = Math.max(0, buffer.length - Math.max(0, Math.floor(limit)))
    const lines: string[] = []
    for (let row = start; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    }
    return lines
  }

  getCwd(): string | null {
    return this.oscText.cwd
  }

  setCwd(cwd: string | null): void {
    this.oscText.cwd = cwd
  }

  setLastTitle(title: string): void {
    this.oscText.lastTitle = title
  }

  setRestoredOscLinks(links: TerminalOscLinkRange[] | undefined): void {
    this.restoredOscLinks = links?.slice() ?? []
  }

  clearScrollback(): void {
    this.restoredOscLinks = []
    this.terminal.clear()
  }

  dispose(): void {
    this.disposed = true
    this.terminal.dispose()
  }
}
