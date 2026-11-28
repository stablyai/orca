import type { Mermaid } from 'mermaid'
import type { PageMermaid } from './mermaid-page-engine'

export type { PageMermaid }

// Check interface against precise package Mermaid type in app program: minified artifact exports are any and cannot prove signatures.
// Keep outside tests excluded from shipped app typecheck. Both browser render checks prove artifact behavior beyond static package compatibility.
const _packageSatisfiesPageMermaid: (engine: Mermaid) => PageMermaid = (engine) => engine

// Defer one pre-bundled artifact: package import emits 103 already-downloaded scripts against 256-asset cap, saving no transfer. No diagram means no engine evaluation.
export async function loadPageMermaid(): Promise<PageMermaid | null> {
  const engine = await import('./mermaid-page-engine.generated')
  return engine.default
}
