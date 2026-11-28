import type { MermaidConfig } from 'mermaid'

// Name page’s two mermaid calls as checked interface.
export type PageMermaid = {
  initialize: (config: MermaidConfig) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

// Native renders have no DOM container for Mermaid SVG output; keep the 3 MiB page engine and its KaTeX import out of native bundles.
export function loadPageMermaid(): Promise<PageMermaid | null> {
  return Promise.resolve(null)
}
