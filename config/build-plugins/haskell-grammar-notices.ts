import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

const notices = [
  { name: 'LICENSE', relation: 'license' },
  { name: 'UPSTREAM', relation: 'describedby' }
] as const

export function createHaskellGrammarNoticesPlugin(): Plugin {
  return {
    name: 'haskell-grammar-notices',
    apply: 'build',
    buildStart() {
      for (const { name } of notices) {
        this.emitFile({
          type: 'asset',
          fileName: `assets/language-haskell-${name}.txt`,
          source: readFileSync(
            new URL(`../../resources/licenses/language-haskell/${name}.txt`, import.meta.url)
          )
        })
      }
    },
    transformIndexHtml() {
      return notices.map(({ name, relation }) => ({
        tag: 'link',
        attrs: {
          rel: relation,
          type: 'text/plain',
          href: `./assets/language-haskell-${name}.txt`,
          title: `Haskell grammar ${name === 'LICENSE' ? 'license' : 'provenance'}`
        },
        injectTo: 'head'
      }))
    }
  }
}
