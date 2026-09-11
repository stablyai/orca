import type { PiAgentKind } from '../../shared/pi-agent-kind'

export function getPiTitlebarPromptSourceLines(kind: PiAgentKind): string[] {
  return kind === 'pi'
    ? [
        "  on('ui_prompt_start', async (_event, ctx) => {",
        '    if (isOmpRuntime() || !ownsMarker) return',
        '    promptDepth++',
        '    // Why: retry on every open rather than only the outermost, so an outer ctx',
        '    // that could not paint cannot decide the whole stack stays unmarked.',
        '    if (markerPainted) return',
        '    const painter = resolvePainter(ctx)',
        '    // Why: only hold the spinner off once the marker is actually up, or a ctx',
        '    // that cannot paint would freeze the title on its last working frame.',
        "    if (!paintTitle(painter, () => getMarkedTitle(pi, '!'))) return",
        '    markerPainted = true',
        '    promptCtx = painter',
        '    startMarkerReassert(painter)',
        '  })',
        '',
        "  on('ui_prompt_end', async (_event, ctx) => {",
        '    if (isOmpRuntime() || !ownsMarker || promptDepth === 0) return',
        '    promptDepth--',
        '    if (promptDepth > 0) return',
        '    // Why: the opening ctx already painted once, so a close whose own ctx is stale',
        '    // does not leave the needs-input marker up until the next turn.',
        '    const painter = resolvePainter(ctx) ?? promptCtx',
        '    markerPainted = false',
        '    promptCtx = null',
        '    stopMarkerReassert()',
        '    // Why: a still-live turn resumes its spinner in place; otherwise the pane is idle',
        '    // and must drop the needs-input marker rather than keep asking for attention.',
        '    if (timer) {',
        '      renderFrame(painter)',
        '      return',
        '    }',
        '    paintTitle(painter, () => getBaseTitle(pi))',
        '  })',
        ''
      ]
    : []
}
