import type { PiAgentKind } from '../../shared/pi-agent-kind'

export const MCODE_PI_PREFILL_EXTENSION_FILE = 'mcode-prefill.ts'

// Why: prefill-without-submit needs an env-var the bundled `mcode-prefill.ts`
// extension can read on session_start. Each kind owns its own variable so an
// OMP PTY never honors a Pi draft (or vice versa).
type PrefillAgentKind = Exclude<PiAgentKind, 'prime-agent'>

const PREFILL_ENV_VAR_BY_KIND: Record<PrefillAgentKind, string> = {
  pi: 'MCODE_PI_PREFILL',
  omp: 'MCODE_OMP_PREFILL'
}

export function getPiPrefillExtensionSource(kind: PrefillAgentKind): string {
  const envVar = PREFILL_ENV_VAR_BY_KIND[kind]
  return [
    'export default function (pi) {',
    "  pi.on('session_start', async (event, ctx) => {",
    '    if (!process.env.MCODE_PANE_KEY) return',
    "    if (event.reason !== 'startup') return",
    `    const prefill = process.env.${envVar}`,
    '    if (!prefill) return',
    `    delete process.env.${envVar}`,
    '    try {',
    '      ctx.ui.setEditorText(prefill)',
    '    } catch {}',
    '  })',
    '}',
    ''
  ].join('\n')
}
