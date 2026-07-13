import { readFile } from 'node:fs/promises'
import { Language, Parser, Query } from 'web-tree-sitter'
import type { SymbolDef } from '../../shared/symbol-index'
import { getLanguageConfig } from './language-config'
import { grammarWasmPath, runtimeWasmPath } from './grammar-registry'

let initPromise: Promise<void> | null = null
const languages = new Map<string, Language>()
const queries = new Map<string, Query>()

export function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: () => runtimeWasmPath()
    })
  }
  return initPromise
}

async function loadLanguage(grammarKey: string): Promise<Language | null> {
  const existing = languages.get(grammarKey)
  if (existing) {
    return existing
  }
  const wasm = grammarWasmPath(grammarKey)
  if (!wasm) {
    return null
  }
  try {
    const bytes = await readFile(wasm)
    const lang = await Language.load(bytes)
    languages.set(grammarKey, lang)
    return lang
  } catch {
    return null
  }
}

export async function parseDefinitions(
  languageId: string,
  source: string,
  absPath: string
): Promise<SymbolDef[]> {
  const cfg = getLanguageConfig(languageId)
  if (!cfg) {
    return []
  }

  try {
    await initParser()
    const lang = await loadLanguage(cfg.grammarKey)
    if (!lang) {
      return []
    }

    const parser = new Parser()
    try {
      parser.setLanguage(lang)
      let tree
      try {
        tree = parser.parse(source)
      } catch {
        return []
      }
      if (!tree) {
        return []
      }

      try {
        let query = queries.get(cfg.grammarKey)
        if (!query) {
          query = new Query(lang, cfg.query)
          queries.set(cfg.grammarKey, query)
        }

        const out: SymbolDef[] = []
        for (const match of query.matches(tree.rootNode)) {
          for (const capture of match.captures) {
            if (capture.name !== 'name') {
              continue
            }
            const node = capture.node
            out.push({
              name: node.text,
              kind: 'function', // kind refinement is future work; name-based jump doesn't need it
              path: absPath,
              line: node.startPosition.row + 1,
              column: node.startPosition.column + 1
            })
          }
        }
        return out
      } finally {
        tree.delete()
      }
    } finally {
      parser.delete()
    }
  } catch {
    // Never throw for bad input/unexpected grammar errors — caller falls back.
    return []
  }
}
