import type { PiAgentKind } from '../../../../shared/agent-launch/catalog/pi-agent-kind'

/** Mail delivery types into the terminal, so it must wait while the input box holds unsent text. Pi
 *  knows its own box whatever an extension draws, so report it rather than have Orca read the screen. */
export function getPiAgentStatusComposerDraftSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }
  return [
    'type ComposerDraftState = { acked: boolean | undefined; retries: number }',
    'declare global { var __orcaPiComposerDraft: ComposerDraftState | undefined }',
    // Why: the post queue outlives /reload, so what Orca last received must outlive it too.
    'const composerDraftState: ComposerDraftState = globalThis.__orcaPiComposerDraft ??= { acked: undefined, retries: 0 }',
    'let composerDraftUi: { getEditorText?: () => unknown } | null = null',
    'let stopComposerDraftInput: (() => void) | null = null',
    'let composerDraftCheck: ReturnType<typeof setTimeout> | null = null',
    '',
    'function readComposerDraft(): boolean | undefined {',
    '  try {',
    '    const text = composerDraftUi?.getEditorText?.()',
    "    return typeof text === 'string' ? text.trim() !== '' : undefined",
    '  } catch {',
    '    return undefined',
    '  }',
    '}',
    '',
    'function scheduleComposerDraftCheck(delayMs = 0): void {',
    '  if (composerDraftCheck !== null) return',
    // Why: input listeners run before the editor applies the key, so read once it has landed.
    '  composerDraftCheck = setTimeout(() => {',
    '    composerDraftCheck = null',
    '    const next = readComposerDraft()',
    // Why: compare only with what Orca received; a post in flight can still fail or never settle.
    '    if (next === undefined || next === composerDraftState.acked) return',
    // A queued post reads the box when it is sent, so it already carries this reading.
    "    if (!hasQueuedPost()) post('composer_draft')",
    '  }, delayMs)',
    "  if (typeof composerDraftCheck.unref === 'function') composerDraftCheck.unref()",
    '}',
    '',
    // Why: every post reads the box afresh, so text an extension sets without a key still reaches Orca.
    'function beginComposerDraftSend(ompRuntime: boolean): boolean | undefined {',
    '  return ompRuntime ? undefined : readComposerDraft()',
    '}',
    '',
    'function endComposerDraftSend(sent: boolean | undefined, delivered: boolean): void {',
    '  if (sent === undefined) return',
    '  if (delivered) {',
    '    composerDraftState.acked = sent',
    '    composerDraftState.retries = 0',
    // Why: the box may have changed back while this report was in flight; an unchanged box posts nothing.
    '    scheduleComposerDraftCheck()',
    '    return',
    '  }',
    // A dropped report must not stand: recheck with backoff so the reading reaches Orca.
    '  if (sent === composerDraftState.acked || composerDraftState.retries >= 3) return',
    '  scheduleComposerDraftCheck(250 * 2 ** composerDraftState.retries++)',
    '}',
    '',
    'function watchComposerDraft(ctx): void {',
    // Native chat has no terminal input box, and OMP keeps its own.
    '  if (process.env.ORCA_STRUCTURED_SESSION || isOmpRuntime()) return',
    '  const ui = ctx?.ui',
    "  if (!ui || ui === composerDraftUi || typeof ui.onTerminalInput !== 'function' || typeof ui.getEditorText !== 'function') return",
    '  stopComposerDraftInput?.()',
    '  composerDraftUi = ui',
    '  stopComposerDraftInput = ui.onTerminalInput(() => {',
    '    composerDraftState.retries = 0',
    '    scheduleComposerDraftCheck()',
    '    return undefined',
    '  })',
    // A /reload or an editor prefilled before this registration may differ from what Orca holds.
    '  scheduleComposerDraftCheck()',
    '}',
    ''
  ]
}

/** postOnce lines that read the box into the body and record whether Orca received it. */
export function getPiAgentStatusComposerDraftPostLines(kind: PiAgentKind): {
  begin: string[]
  delivered: string[]
  end: string[]
  payloadField: string
} {
  if (kind !== 'pi') {
    return { begin: [], delivered: [], end: [], payloadField: '' }
  }
  return {
    begin: [
      '  const composerDraftSent = beginComposerDraftSend(ompRuntime)',
      '  let composerDraftDelivered = false'
    ],
    delivered: ['    composerDraftDelivered = true'],
    end: ['    endComposerDraftSend(composerDraftSent, composerDraftDelivered)'],
    payloadField:
      ' ...(composerDraftSent !== undefined ? { composer_draft: composerDraftSent } : {}),'
  }
}
