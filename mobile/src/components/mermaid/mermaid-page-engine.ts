import type { Mermaid, MermaidConfig } from 'mermaid'

// Name page’s two mermaid calls as checked interface.
export type PageMermaid = {
  initialize: (config: MermaidConfig) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

// Check interface against precise package Mermaid type in app program: minified artifact exports are any and cannot prove signatures.
// Keep outside tests excluded from shipped app typecheck. Both browser render checks prove artifact behavior beyond static package compatibility.
const _packageSatisfiesPageMermaid: (engine: Mermaid) => PageMermaid = (engine) => engine

// Set by a shell that left the engine out of its download: it fetches the engine from the desktop on request.
let fetchEngine: (() => Promise<void>) | null = null
let engineFetched: Promise<void> | null = null

export function publishPageMermaidFetch(fetch: () => Promise<void>): void {
  fetchEngine = fetch
}

// Defer one pre-bundled artifact: package import emits 103 scripts against the 256-asset cap. No diagram means no engine evaluation.
export async function loadPageMermaid(): Promise<PageMermaid> {
  if (fetchEngine !== null) {
    // One fetch for every diagram on the page; a failed one is tried again by the next diagram.
    engineFetched ??= fetchEngine().catch((error: unknown) => {
      engineFetched = null
      throw error
    })
    await engineFetched
  }
  const engine = await import('./mermaid-page-engine.generated')
  return engine.default
}
