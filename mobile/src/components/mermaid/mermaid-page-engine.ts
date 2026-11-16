import type { Mermaid, MermaidConfig } from 'mermaid'

// Name page’s two mermaid calls as checked interface.
export type PageMermaid = {
  initialize: (config: MermaidConfig) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

// Check interface against precise package Mermaid type in app program: minified artifact exports are any and cannot prove signatures.
// Keep outside tests excluded from shipped app typecheck. Both browser render checks prove artifact behavior beyond static package compatibility.
const _packageSatisfiesPageMermaid: (engine: Mermaid) => PageMermaid = (engine) => engine

// Defer one pre-bundled artifact: package import emits 103 already-downloaded scripts against 256-asset cap, saving no transfer. No diagram means no engine evaluation.
export async function loadPageMermaid(): Promise<PageMermaid> {
  const engine = await import('./mermaid-page-engine.generated')
  return engine.default
}
