import type { PiAgentKind } from '../../../../shared/agent-launch/catalog/pi-agent-kind'

/** Mail delivery types into the terminal, so it must wait while the input box holds unsent text. Pi
 *  knows its own box whatever an extension draws, so report it rather than have Orca read the screen. */
export function getPiAgentStatusComposerDraftSourceLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }
  return [
    'let composerDraft: boolean | undefined = undefined',
    'let composerDraftUi: { getEditorText?: () => unknown } | null = null',
    'let stopComposerDraftInput: (() => void) | null = null',
    'let composerDraftCheckQueued = false',
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
    'function scheduleComposerDraftCheck(): void {',
    '  if (composerDraftCheckQueued) return',
    '  composerDraftCheckQueued = true',
    // Why: input listeners run before the editor applies the key, so read once it has landed.
    '  setTimeout(() => {',
    '    composerDraftCheckQueued = false',
    '    const next = readComposerDraft()',
    '    if (next === composerDraft) return',
    '    composerDraft = next',
    // A queued post builds its body at delivery and already carries the new reading.
    "    if (!hasQueuedPost()) post('composer_draft')",
    '  }, 0)',
    '}',
    '',
    'function watchComposerDraft(ctx): void {',
    // Native chat has no terminal input box, and OMP keeps its own.
    '  if (process.env.ORCA_STRUCTURED_SESSION || isOmpRuntime()) return',
    '  const ui = ctx?.ui',
    "  if (!ui || ui === composerDraftUi || typeof ui.onTerminalInput !== 'function' || typeof ui.getEditorText !== 'function') return",
    '  stopComposerDraftInput?.()',
    '  composerDraftUi = ui',
    '  composerDraft = readComposerDraft()',
    '  stopComposerDraftInput = ui.onTerminalInput(() => {',
    '    scheduleComposerDraftCheck()',
    '    return undefined',
    '  })',
    '}',
    ''
  ]
}
