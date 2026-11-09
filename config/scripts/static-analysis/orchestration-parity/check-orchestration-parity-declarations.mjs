import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources } from '../ratchet-baseline/ratchet-baseline.mjs'

// Every orchestration method declares what each agent kind gets in each location (terminal and chat parity).

const DECLARATION = 'src/main/runtime/orchestration/orchestration-parity.md'
// Generated from the RPC registry and checked fresh in CI, so it lists every registered method.
const CATALOG = 'src/shared/rpc-contract/rpc-params-catalog.generated.ts'
const LABELS = [
  'Terminal · Local',
  'Chat · Local',
  'Terminal · Paired',
  'Chat · Paired',
  'Terminal · SSH/WSL',
  'Chat · SSH/WSL'
]
const CELL = /^(?:supported(?:: .+)?|refused `([a-z_]+)`: .+|n\/a: .+)$/

// Both catalog lists are generated from the registry: methods with shared params, then those without.
export function registeredMethods(catalogText) {
  return new Set(
    [...catalogText.matchAll(/^\s*'(orchestration\.[A-Za-z]+)'[:,\n]/gm)].map((m) => m[1])
  )
}

/** Each `## \`orchestration.x\`` section, as its `- <label>: <cell>` lines. */
export function declaredSections(markdown) {
  const sections = []
  for (const line of markdown.split('\n')) {
    const method = /^## `(orchestration\.[A-Za-z]+)`$/.exec(line)?.[1]
    if (method) {
      sections.push({ method, cells: [] })
      continue
    }
    const cell = /^- ([^:]+): (.+)$/.exec(line)
    if (cell && sections.length > 0) {
      sections.at(-1).cells.push({ label: cell[1], value: cell[2] })
    }
  }
  return sections
}

/** `codeExists` says whether a refusal code is a real string literal in the source. */
export function censusProblems(methods, sections, codeExists) {
  const problems = []
  const declared = new Set()
  for (const { method, cells } of sections) {
    if (declared.has(method)) {
      problems.push(`${method}: declared twice.`)
    }
    declared.add(method)
    if (!methods.has(method)) {
      problems.push(`${method}: declared, but no such method is registered.`)
    }
    const labels = cells.map((cell) => cell.label).join('\n')
    if (labels !== 'All' && labels !== LABELS.join('\n')) {
      problems.push(`${method}: list ${LABELS.join(', ')} in that order, or one All line.`)
    }
    for (const { value } of cells) {
      const match = CELL.exec(value)
      if (!match) {
        problems.push(
          `${method}: "${value}" is not supported, refused \`<code>\`: <reason>, or n/a: <reason>.`
        )
      } else if (match[1] && !codeExists(match[1])) {
        problems.push(`${method}: refusal code ${match[1]} appears nowhere in src.`)
      }
    }
  }
  for (const method of [...methods].sort()) {
    if (!declared.has(method)) {
      problems.push(`${method}: no section; declare it in ${DECLARATION}.`)
    }
  }
  return problems
}

export function main(root = process.cwd()) {
  const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
  const sources = [
    ...readTrackedSources(root, ['src/main', 'src/shared'], (rel) => rel.endsWith('.ts')).values()
  ]
  const codeExists = (code) => sources.some((text) => text.includes(`'${code}'`))
  const problems = censusProblems(
    registeredMethods(read(CATALOG)),
    declaredSections(read(DECLARATION)),
    codeExists
  )
  for (const problem of problems) {
    console.error(problem)
  }
  if (problems.length > 0) {
    console.error(
      `${problems.length} orchestration parity problem(s). Sections describe the code as it is.`
    )
    return 1
  }
  console.log('Orchestration parity declaration OK.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
