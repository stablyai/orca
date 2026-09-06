import { applyEdits, modify, parse, visit, type ParseError } from 'jsonc-parser'
import { isRecord } from './chrome-devtools-config'

export function parseJsoncConfig(
  contents: string,
  path: string,
  label = 'config'
): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed: unknown = parse(contents, errors, { allowTrailingComma: true })
  const keys: Set<string>[] = []
  let duplicate = false
  visit(contents, {
    onObjectBegin: () => {
      keys.push(new Set())
    },
    onObjectProperty: (key) => {
      const current = keys.at(-1)
      if (!current) {
        return
      }
      if (current.has(key)) {
        duplicate = true
      }
      current.add(key)
    },
    onObjectEnd: () => {
      keys.pop()
    }
  })
  if (errors.length || duplicate || !isRecord(parsed)) {
    throw new Error(`Invalid or ambiguous ${label} JSON/JSONC config: ${path}`)
  }
  return parsed
}

export function editJsoncConfig(source: string, path: string[], value: unknown): string {
  return applyEdits(
    source,
    modify(source, path, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: source.includes('\r\n') ? '\r\n' : '\n'
      }
    })
  )
}
