import type { PiAgentKind } from '../../shared/pi-agent-kind'

export const ORCA_PI_PREFILL_EXTENSION_FILE = 'orca-prefill.ts'

// Why: prefill-without-submit needs an env-var the bundled `orca-prefill.ts`
// extension can read on session_start. Each kind owns its own variable so an
// OMP PTY never honors a Pi draft (or vice versa).
type PrefillAgentKind = Exclude<PiAgentKind, 'prime-agent'>

const PREFILL_ENV_VAR_BY_KIND: Record<PrefillAgentKind, string> = {
  pi: 'ORCA_PI_PREFILL',
  omp: 'ORCA_OMP_PREFILL'
}

export function getPiPrefillExtensionSource(kind: PrefillAgentKind): string {
  return ['export default function (pi) {', ...getPiPrefillHandlerSourceLines(kind), '}', ''].join(
    '\n'
  )
}

export function getPiPrefillHandlerSourceLines(kind: PrefillAgentKind): string[] {
  const envVar = PREFILL_ENV_VAR_BY_KIND[kind]
  return [
    "  pi.on('session_start', async (event, ctx) => {",
    '    if (!process.env.ORCA_PANE_KEY || ctx?.hasUI === false) return',
    ...(kind === 'pi' ? ["    if (event.reason !== 'startup') return"] : []),
    `    const prefill = process.env.${envVar}`,
    "    if (!prefill || typeof ctx?.ui?.setEditorText !== 'function') return",
    `    delete process.env.${envVar}`,
    '    try {',
    '      ctx.ui.setEditorText(prefill)',
    '    } catch {}',
    '  })'
  ]
}
