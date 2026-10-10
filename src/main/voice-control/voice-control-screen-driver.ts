import type { VoiceUiActionResult } from '../../shared/voice-control-types'
import { buildSnapshot, type CdpCommandSender, type RefEntry } from '../browser/snapshot-engine'
import { traceVoiceScreenDriver } from './voice-control-tracing'

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * see_screen / click_element / type_into / read_terminal against the session-owner
 * window. Reuses the browser-automation snapshot engine (`snapshot-engine.ts`) over the
 * window's own CDP debugger instead of a renderer round-trip: the AX tree walk,
 * cursor-interactive promotion, and stale-ref detection come with it, and synthetic
 * Input events work on every React control without renderer cooperation. xterm panes
 * are excluded from the tree (scrollback would drown out the UI); their visible text is
 * one `Runtime.evaluate` away via readTerminalText.
 */

/** The narrow slice of Electron's WebContents.debugger the driver uses — seam-injected. */
export type VoiceCdpDebugger = {
  isAttached: () => boolean
  attach: (protocolVersion: string) => void
  on: (event: 'detach', listener: () => void) => void
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

export type VoiceScreenDriverDeps = {
  /** The session-owner window's debugger; null when there is no owner window. */
  getDebugger: () => VoiceCdpDebugger | null
  /** Post-action settle delay before the fresh snapshot; 0 in tests. */
  settleMs?: number
}

const TREE_LINE_LIMIT = 320
const TERMINAL_LINE_LIMIT = 120
const XTERM_SELECTOR = '.xterm'

/** Names the failing CDP method in the error — a bare "Invalid parameters" with no method attached cost a whole live session of guesswork. */
function namingStepFailures(sender: CdpCommandSender): CdpCommandSender {
  return (method, params) =>
    sender(method, params).catch((error: unknown) => {
      throw new Error(`${method}: ${error instanceof Error ? error.message : String(error)}`)
    })
}

export class VoiceScreenDriver {
  /** The debugger instance we attached to — identity-compared so an owner change resets. */
  private attachedTo: VoiceCdpDebugger | null = null
  private refMap = new Map<string, RefEntry>()
  private refDisplayNames = new Map<string, string>()

  constructor(private readonly deps: VoiceScreenDriverDeps) {}

  async seeScreen(): Promise<string | null> {
    const sender = this.senderOrNull()
    if (!sender) {
      return null
    }
    try {
      const exclude = await this.xtermBackendNodeIds(sender)
      const result = await buildSnapshot(sender, undefined, undefined, exclude)
      this.refMap = result.refMap
      this.refDisplayNames = new Map(result.refs.map((ref) => [ref.ref, ref.name]))
      const lines = result.snapshot.split('\n')
      const capped =
        lines.length > TREE_LINE_LIMIT
          ? `${lines.slice(0, TREE_LINE_LIMIT).join('\n')}\n… (${lines.length - TREE_LINE_LIMIT} more lines not shown — scroll or narrow the view)`
          : result.snapshot
      return exclude.size > 0
        ? `${capped}\n(One or more terminal panes are visible but not in this tree; read_terminal shows their visible text.)`
        : capped
    } catch (error) {
      // A detach mid-snapshot (user opened DevTools) reads as "can't see it", not a crash.
      this.attachedTo = null
      traceVoiceScreenDriver('snapshot-failed', errorDetail(error))
      return null
    }
  }

  async clickElement(ref: string): Promise<VoiceUiActionResult | null> {
    const resolved = await this.resolveForAction(ref)
    if ('ok' in resolved) {
      return resolved
    }
    const { sender, backendDOMNodeId } = resolved
    const step = namingStepFailures(sender)
    try {
      await this.scrollIntoView(step, backendDOMNodeId)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM.getBoxModel's wire shape is fixed; content is the 8-number quad.
      const { model } = (await step('DOM.getBoxModel', { backendNodeId: backendDOMNodeId })) as {
        model: { content: number[] }
      }
      const [x1, y1, , , x3, y3] = model.content
      const cx = (x1 + x3) / 2
      const cy = (y1 + y3) / 2
      // mouseMoved first so hover-dependent controls reveal themselves before the press.
      await step('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
      await step('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })
      await step('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })
      return await this.okWithFreshTree(resolved.displayName)
    } catch (error) {
      traceVoiceScreenDriver('click-failed', errorDetail(error))
      return {
        ok: false,
        error: `Element ${ref} could not be clicked — it may have moved or hidden. Call see_screen for fresh refs.`
      }
    }
  }

  async typeInto(ref: string, text: string): Promise<VoiceUiActionResult | null> {
    const resolved = await this.resolveForAction(ref)
    if ('ok' in resolved) {
      return resolved
    }
    const { sender, backendDOMNodeId } = resolved
    const step = namingStepFailures(sender)
    try {
      const objectId = await this.remoteObjectId(step, backendDOMNodeId)
      // One round-trip guards the two refusal cases, then focuses for the insertion.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callFunctionOn echoes exactly what the function returns; the literal union below is that contract.
      const { result } = (await step('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          if (this.closest('${XTERM_SELECTOR}')) return 'terminal'
          if (!(this instanceof HTMLInputElement) && !(this instanceof HTMLTextAreaElement)) return 'not-a-field'
          if (this.disabled || this.readOnly) return 'readonly'
          this.focus()
          return 'ok'
        }`
      })) as { result: { value: string } }
      if (result.value === 'terminal') {
        return {
          ok: false,
          error:
            'That field is a terminal pane — typing there is not supported. Use run_command for shell input.'
        }
      }
      if (result.value === 'not-a-field') {
        return { ok: false, error: `Element ${ref} is not a text field.` }
      }
      if (result.value === 'readonly') {
        return { ok: false, error: `Element ${ref} is disabled or read-only.` }
      }
      // insertText goes through the IME path, so React controlled inputs accept it.
      await step('Input.insertText', { text })
      return await this.okWithFreshTree(resolved.displayName)
    } catch (error) {
      traceVoiceScreenDriver('type-failed', errorDetail(error))
      return {
        ok: false,
        error: `Element ${ref} could not be typed into — call see_screen for fresh refs.`
      }
    }
  }

  /**
   * read_terminal: the visible text of the terminal pane(s) on screen. xterm renders its
   * viewport as DOM rows, and innerText of a hidden pane is empty — so this reads exactly
   * what the user sees, no PTY surgery. Tail-capped: recent output is what gets asked about.
   */
  async readTerminalText(): Promise<string | null> {
    const sender = this.senderOrNull()
    if (!sender) {
      return null
    }
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: returnByValue echoes the expression's string result verbatim.
      const { result } = (await sender('Runtime.evaluate', {
        expression:
          "Array.from(document.querySelectorAll('.xterm-rows')).map((rows) => rows.innerText).filter((text) => text.trim().length > 0).join('\\n')",
        returnByValue: true
      })) as { result: { value: string } }
      const lines = result.value.split('\n')
      return lines.length > TERMINAL_LINE_LIMIT
        ? lines.slice(-TERMINAL_LINE_LIMIT).join('\n')
        : result.value
    } catch (error) {
      this.attachedTo = null
      traceVoiceScreenDriver('read-terminal-failed', errorDetail(error))
      return null
    }
  }

  private senderOrNull(): CdpCommandSender | null {
    const dbg = this.deps.getDebugger()
    if (!dbg) {
      traceVoiceScreenDriver('no-owner-window')
      return null
    }
    if (this.attachedTo !== dbg) {
      if (dbg.isAttached()) {
        // Someone else (the user's DevTools) holds the session; never steal it.
        traceVoiceScreenDriver('refused-devtools-held')
        return null
      }
      try {
        dbg.attach('1.3')
      } catch (error) {
        traceVoiceScreenDriver('attach-failed', errorDetail(error))
        return null
      }
      dbg.on('detach', () => {
        this.attachedTo = null
        this.refMap.clear()
        traceVoiceScreenDriver('detached')
      })
      this.attachedTo = dbg
      traceVoiceScreenDriver('attached')
    }
    return (method, params) => dbg.sendCommand(method, params)
  }

  private async resolveForAction(
    ref: string
  ): Promise<
    | { sender: CdpCommandSender; backendDOMNodeId: number; displayName: string }
    | VoiceUiActionResult
  > {
    const sender = this.senderOrNull()
    if (!sender) {
      return { ok: false, error: 'The screen is not available right now.' }
    }
    // The tree prints refs as [@e12] and the model sometimes transcribes without the
    // sigil (live: "e36" looped on Unknown ref until the coordinator gave up and blamed
    // a "changing screen"). Normalize rather than punish a transcription slip.
    const key = ref.startsWith('@') ? ref : `@${ref}`
    const entry = this.refMap.get(key)
    if (!entry) {
      // "Call see_screen first" is a lie when one just ran — say which case this is.
      return {
        ok: false,
        error:
          this.refMap.size === 0
            ? 'No see_screen snapshot exists yet — call see_screen; its refs are the only ones click_element accepts.'
            : `Unknown ref "${key}" — the latest see_screen holds ${this.refMap.size} refs (@e1 up). If the screen changed since, call see_screen again for fresh refs.`
      }
    }
    try {
      await sender('DOM.describeNode', { backendNodeId: entry.backendDOMNodeId })
    } catch {
      return {
        ok: false,
        error: `Element ${ref} is gone — the screen changed since the snapshot. Call see_screen again.`
      }
    }
    return {
      sender,
      backendDOMNodeId: entry.backendDOMNodeId,
      displayName: this.refDisplayNames.get(ref) ?? entry.name
    }
  }

  private async scrollIntoView(sender: CdpCommandSender, backendDOMNodeId: number): Promise<void> {
    const objectId = await this.remoteObjectId(sender, backendDOMNodeId)
    await sender('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }"
    })
  }

  private async remoteObjectId(
    sender: CdpCommandSender,
    backendDOMNodeId: number
  ): Promise<string> {
    // DOM.resolveNode takes a backendNodeId directly. DOM.requestNode does NOT — it
    // wants a Runtime objectId, so the two-hop form dies with "Invalid parameters" on
    // every click (CDP-probed; the old fixture only echoed the wrong contract).
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM.resolveNode's wire shape is fixed; object.objectId is always present on success.
    const { object } = (await sender('DOM.resolveNode', { backendNodeId: backendDOMNodeId })) as {
      object: { objectId: string }
    }
    return object.objectId
  }

  private async okWithFreshTree(elementName: string): Promise<VoiceUiActionResult> {
    // React flushes the action's state update asynchronously; settle before re-reading.
    await new Promise((resolve) => setTimeout(resolve, this.deps.settleMs ?? 150))
    const tree = await this.seeScreen()
    return {
      ok: true,
      elementName,
      tree: tree ?? '(The action landed, but re-reading the screen failed.)'
    }
  }

  /** backendDOMNodeIds of every xterm pane, so the AX walk skips terminal scrollback. */
  private async xtermBackendNodeIds(sender: CdpCommandSender): Promise<Set<number>> {
    const ids = new Set<number>()
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM.getDocument's wire shape is fixed; root.nodeId is always present.
      const { root } = (await sender('DOM.getDocument', { depth: 1 })) as {
        root: { nodeId: number }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM.querySelectorAll's wire shape is fixed; nodeIds is always an array.
      const { nodeIds } = (await sender('DOM.querySelectorAll', {
        nodeId: root.nodeId,
        selector: XTERM_SELECTOR
      })) as { nodeIds: number[] }
      for (const nodeId of nodeIds) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM.describeNode's wire shape is fixed; node.backendNodeId is always present.
        const { node } = (await sender('DOM.describeNode', { nodeId })) as {
          node: { backendNodeId: number }
        }
        ids.add(node.backendNodeId)
      }
    } catch {
      // DOM domain hiccup — snapshot unfiltered rather than not at all.
    }
    return ids
  }
}
