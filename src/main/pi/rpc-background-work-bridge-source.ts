// Relay Pi's shared session-liveness registry to the RPC host: in-process hosts read it before
// idle eviction, but native chat runs Pi as a child, so a status line carries the answer out.

export const PI_BACKGROUND_WORK_STATUS_KEY = 'orca-background-work'
export const PI_BACKGROUND_WORK_ACTIVE = 'active'
export const PI_BACKGROUND_WORK_BRIDGE_FILE = 'orca-background-work.ts'
const SESSION_LIVENESS_REGISTRY_KEY = '@agegr/pi-web/session-liveness/v1'
const REPORT_INTERVAL_MS = 5_000

export function getPiBackgroundWorkBridgeSource(): string {
  return [
    `const REGISTRY = Symbol.for(${JSON.stringify(SESSION_LIVENESS_REGISTRY_KEY)})`,
    `const STATUS_KEY = ${JSON.stringify(PI_BACKGROUND_WORK_STATUS_KEY)}`,
    '',
    // Providers register in their own session_start, which can run before ours, so install at load.
    'function sessionLivenessRegistry() {',
    '  const existing = globalThis[REGISTRY]',
    "  if (existing && typeof existing === 'object' && existing.version === 1 && typeof existing.register === 'function' && typeof existing.hasActiveProvider === 'function') return existing",
    '  const providers = new Map()',
    '  const registry = {',
    '    version: 1,',
    '    register(provider) {',
    "      if (!provider || typeof provider !== 'object' || typeof provider.isActive !== 'function' || typeof provider.sessionId !== 'string' || !provider.sessionId) throw new Error('Session liveness provider is invalid')",
    '      const key = Symbol(String(provider.name))',
    '      providers.set(key, provider)',
    '      let released = false',
    '      return () => {',
    '        if (released) return',
    '        released = true',
    '        providers.delete(key)',
    '      }',
    '    },',
    '    hasActiveProvider(session) {',
    '      const ids = new Set([session.sessionId, session.sessionFile].filter(Boolean))',
    '      for (const provider of providers.values()) {',
    '        if (!ids.has(provider.sessionId) && !(provider.sessionFile && ids.has(provider.sessionFile))) continue',
    // A failing or malformed provider preserves the session rather than releasing its work.
    '        try {',
    '          if (provider.isActive() !== false) return true',
    '        } catch {',
    '          return true',
    '        }',
    '      }',
    '      return false',
    '    }',
    '  }',
    '  globalThis[REGISTRY] = registry',
    '  return registry',
    '}',
    '',
    'export default function (pi) {',
    '  const registry = sessionLivenessRegistry()',
    '  let timer = null',
    '  let reported = null',
    '  function stop() {',
    '    if (timer) clearInterval(timer)',
    '    timer = null',
    '  }',
    // Report only changes; the host keeps the last answer, since a paused reader is not idle work.
    "  pi.on('session_start', (_event, ctx) => {",
    '    stop()',
    '    reported = null',
    '    const tick = () => {',
    '      try {',
    '        const manager = ctx.sessionManager',
    '        const active = registry.hasActiveProvider({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() })',
    `        const next = active ? ${JSON.stringify(PI_BACKGROUND_WORK_ACTIVE)} : undefined`,
    '        if (next === reported) return',
    '        ctx.ui.setStatus(STATUS_KEY, next)',
    '        reported = next',
    '      } catch {',
    // A replaced session's context throws; its successor reports from its own session_start.
    '        stop()',
    '      }',
    '    }',
    '    tick()',
    `    timer = setInterval(tick, ${REPORT_INTERVAL_MS})`,
    "    if (typeof timer.unref === 'function') timer.unref()",
    '  })',
    "  pi.on('session_shutdown', (_event, ctx) => {",
    '    stop()',
    '    try {',
    '      ctx.ui.setStatus(STATUS_KEY, undefined)',
    '    } catch {}',
    '  })',
    '}',
    ''
  ].join('\n')
}
