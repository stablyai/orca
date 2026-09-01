import type { PiAgentKind } from '../../shared/pi-agent-kind'

type BackgroundActivitySourceLines = {
  setup: string[]
  functions: string[]
  eventHandlers: string[]
}

// Process-global state survives Pi's in-process extension reload while generation guards retire old listeners.
export function getPiAgentStatusBackgroundActivitySourceLines(
  kind: PiAgentKind
): BackgroundActivitySourceLines {
  return {
    setup: [
      "  const backgroundActivitySlot = Symbol.for('orca.pi.agent-status-background-activity')",
      '  type BackgroundActivityRegistry = {',
      '    activeSubagentIds: Set<string>',
      '    leadAgentActive: boolean',
      '    completionReported: boolean',
      '    completionPending: boolean',
      '    completionTimer: ReturnType<typeof setTimeout> | null',
      '    generation: number',
      '  }',
      '  const backgroundActivityGlobal = globalThis as typeof globalThis & { [backgroundActivitySlot]?: BackgroundActivityRegistry }',
      '  const backgroundActivity = backgroundActivityGlobal[backgroundActivitySlot] ?? {',
      '    activeSubagentIds: new Set<string>(),',
      '    leadAgentActive: false,',
      '    completionReported: false,',
      '    completionPending: false,',
      '    completionTimer: null,',
      '    generation: 0,',
      '  }',
      '  backgroundActivityGlobal[backgroundActivitySlot] = backgroundActivity',
      '  backgroundActivity.generation += 1',
      '  const extensionGeneration = backgroundActivity.generation',
      '  if (backgroundActivity.completionTimer !== null) {',
      '    clearTimeout(backgroundActivity.completionTimer)',
      '    backgroundActivity.completionTimer = null',
      '  }'
    ],
    functions: [
      '  function isEffectivelyWorking(): boolean {',
      '    return backgroundActivity.leadAgentActive || backgroundActivity.activeSubagentIds.size > 0',
      '  }',
      '',
      '  function clearDeferredAgentEnd(): void {',
      '    backgroundActivity.completionPending = false',
      '    if (backgroundActivity.completionTimer !== null) clearTimeout(backgroundActivity.completionTimer)',
      '    backgroundActivity.completionTimer = null',
      '  }',
      '',
      '  function markLeadAgentActive(): void {',
      '    clearDeferredAgentEnd()',
      '    backgroundActivity.leadAgentActive = true',
      '    backgroundActivity.completionReported = false',
      '  }',
      '',
      '  function resetBackgroundActivity(): void {',
      '    clearDeferredAgentEnd()',
      '    backgroundActivity.activeSubagentIds.clear()',
      '    backgroundActivity.leadAgentActive = false',
      '    backgroundActivity.completionReported = false',
      '  }',
      '',
      '  // Why: isIdle flips before agent_settled handlers run, so both paths',
      '  // share a per-run guard instead of racing duplicate completion posts.',
      '  function postAgentEndOnce(): void {',
      '    if (backgroundActivity.completionReported || isEffectivelyWorking()) return',
      '    backgroundActivity.completionReported = true',
      '    backgroundActivity.completionPending = false',
      "    post('agent_end')",
      '  }',
      '',
      '  function settleLeadAgent(): void {',
      '    backgroundActivity.leadAgentActive = false',
      '    postAgentEndOnce()',
      '  }',
      '',
      '  function scheduleDeferredAgentEnd(): void {',
      '    backgroundActivity.completionPending = true',
      '    if (backgroundActivity.completionTimer !== null) return',
      '    backgroundActivity.completionTimer = setTimeout(() => {',
      '      backgroundActivity.completionTimer = null',
      '      if (backgroundActivity.generation !== extensionGeneration || !backgroundActivity.completionPending) return',
      '      postAgentEndOnce()',
      '    }, 0)',
      "    if (typeof backgroundActivity.completionTimer.unref === 'function') backgroundActivity.completionTimer.unref()",
      '  }',
      ''
    ],
    eventHandlers:
      kind === 'pi'
        ? [
            '  const processEvents = (pi as { events?: { on?: (name: string, handler: (payload: unknown) => void) => unknown } }).events',
            "  processEvents?.on?.('subagent:async-started', (payload: unknown) => {",
            '    if (backgroundActivity.generation !== extensionGeneration) return',
            '    const id = (payload as { id?: unknown } | null)?.id',
            "    if (typeof id !== 'string' || !id || backgroundActivity.activeSubagentIds.has(id)) return",
            '    const wasWorking = isEffectivelyWorking()',
            '    backgroundActivity.activeSubagentIds.add(id)',
            '    clearDeferredAgentEnd()',
            '    backgroundActivity.completionReported = false',
            "    if (!wasWorking) post('agent_start')",
            '  })',
            '',
            "  processEvents?.on?.('subagent:async-complete', (payload: unknown) => {",
            '    if (backgroundActivity.generation !== extensionGeneration) return',
            '    const runId = (payload as { runId?: unknown } | null)?.runId',
            "    if (typeof runId !== 'string' || !runId || !backgroundActivity.activeSubagentIds.delete(runId)) return",
            '    if (!isEffectivelyWorking()) scheduleDeferredAgentEnd()',
            '  })',
            ''
          ]
        : []
  }
}
