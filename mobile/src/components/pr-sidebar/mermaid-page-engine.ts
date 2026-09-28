import type { Mermaid, MermaidConfig } from 'mermaid'

/**
 * The two calls the page makes of mermaid, named rather than cast.
 */
export type PageMermaid = {
  initialize: (config: MermaidConfig) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

/**
 * The package's own API satisfies the type above, asserted at compile time.
 *
 * The loader's return does not assert it. The artifact is minified vendor output and both members
 * measure as `any` there (a probe assigning `engine.render` to a `number` compiles), and `any`
 * satisfies every signature, so returning it as `PageMermaid` checks the two names and nothing
 * about their shapes. This does: `Mermaid` is precise, so a `PageMermaid` member whose signature
 * the engine does not really have fails here instead of at a call the page makes. It lives beside
 * the type it constrains rather than in a test: `mobile/tsconfig.json` excludes `*.test.ts`, so the
 * app's own typecheck would not cover it there. Tests are typechecked too, by `tsconfig.test.json`
 * through the tests-typecheck ratchet, but that is a second program with a grandfathered baseline
 * and a few files held outside it on purpose, and it is not the gate the shipped build rests on.
 *
 * What no type can check is that the bundle behaves like the package. The render check is that, in
 * both engines, against the native document's own bytes.
 */
const _packageSatisfiesPageMermaid: (engine: Mermaid) => PageMermaid = (engine) => engine

/**
 * The page's mermaid, loaded on demand from one pre-bundled artifact.
 *
 * `import('mermaid')` from inside the app bundle would emit 103 scripts, because mermaid lazily
 * imports each of its own diagram types and esbuild splits along those boundaries. Every one of
 * them ships inside the OTA generation the phone has already downloaded, so the split moves no
 * bytes over the wire and spends 103 of the 256 manifest assets the shell will load. The artifact
 * is the same engine in one file, and this import is still the deferred one: a session with no
 * diagram on it evaluates none of it.
 */
export async function loadPageMermaid(): Promise<PageMermaid> {
  const engine = await import('./mermaid-page-engine.generated')
  return engine.default
}
