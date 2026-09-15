// OMP loads the same extension in each in-process task session.
export function getOmpSessionOwnerHandlerSourceLines(): string[] {
  return [
    '  // SessionManager survives reload/new/resume; task children own a different instance.',
    '  function ownsSessionStatus(ctx): boolean {',
    '    if (!isOmpRuntime()) return true',
    '    const manager = ctx?.sessionManager',
    "    if (!manager || typeof manager !== 'object') return true",
    '    // Keep ownership through module reload and shutdown while child sessions drain.',
    "    const key = Symbol.for('orca.omp.status-session-owners')",
    '    let owners = Reflect.get(globalThis, key)',
    '    if (!(owners instanceof Map)) {',
    '      owners = new Map()',
    '      Reflect.set(globalThis, key, owners)',
    '    }',
    '    const pane = JSON.stringify([process.env.ORCA_PANE_KEY, process.env.ORCA_AGENT_LAUNCH_TOKEN])',
    '    const owner = owners.get(pane)',
    '    if (owner) return owner === manager',
    '    owners.set(pane, manager)',
    '    return true',
    '  }',
    '',
    '  function onStatus(name, handler): void {',
    '    pi.on(name, (event, ctx) => {',
    '      if (!ownsSessionStatus(ctx)) return',
    '      return handler(event, ctx)',
    '    })',
    '  }',
    '',
    "  onStatus('session_start', () => {})",
    ''
  ]
}
