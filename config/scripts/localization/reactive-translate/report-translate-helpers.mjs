import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { planHelperThreading } from './helper-threading.mjs'
import { collectI18nCalls, findI18nImports, isRenderPathCall } from './render-path-translate.mjs'
import { loadRendererModules } from './translate-helper-graph.mjs'

// Counts what still reads the UI language outside React's data flow: direct render-path calls,
// and helpers (resolved across files) that translate directly or transitively and are called
// while rendering. Pass --list to print every helper render call site the codemod cannot thread.

function countBy(items, key) {
  const counts = new Map()
  for (const item of items) {
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const modules = loadRendererModules(root)
  let direct = 0
  const directFiles = new Set()
  for (const [rel, { sf }] of modules) {
    if (!/\b(?:translate|getIntlLocale)\b/.test(sf.text)) {
      continue
    }
    const count = collectI18nCalls(sf).calls.filter(isRenderPathCall).length
    if (count > 0) {
      direct += count
      directFiles.add(rel)
    }
  }
  const plan = planHelperThreading(modules, {
    inTargets: () => true,
    findI18nLocals: (sf) => findI18nImports(sf).locals,
    ownerContext: () => ({ ok: true })
  })
  const { graph, info, threaded, renderSites } = plan
  const depths = [...graph.translating.values()]
  const renderUses = []
  for (const entry of info.values()) {
    for (const use of entry.uses) {
      if (use.owner && use.duringRender) {
        renderUses.push({ use, entry })
      }
    }
  }
  const renderHelpers = new Set(renderUses.map(({ entry }) => entry.id))
  const uncovered = renderUses.filter(({ use }) => !renderSites.some((site) => site.use === use))
  const blockedHelpers = [...renderHelpers]
    .map((id) => info.get(id))
    .filter((entry) => entry.blocked.length > 0)
  console.log(
    `Direct render-path translate()/getIntlLocale() calls: ${direct} in ${directFiles.size} file(s)`
  )
  console.log(
    `Translating helpers: ${graph.translating.size} (${depths.filter((d) => d === 0).length} direct, ${depths.filter((d) => d > 0).length} transitive, max depth ${Math.max(0, ...depths)})`
  )
  console.log(
    `Called while rendering: ${renderHelpers.size} helper(s), ${renderUses.length} call site(s) in ${new Set(renderUses.map(({ use }) => use.rel)).size} file(s)`
  )
  console.log(
    `Threadable: ${renderSites.length} call site(s) through ${threaded.size} helper(s) (incl. callees); not threadable: ${uncovered.length} call site(s)`
  )
  console.log('Helpers left for manual work, by reason:')
  for (const [reason, count] of countBy(blockedHelpers, (entry) => entry.blocked[0])) {
    console.log(`  ${count} ${reason}`)
  }
  const unblockedUncovered = uncovered.filter(({ entry }) => entry.blocked.length === 0)
  if (unblockedUncovered.length > 0) {
    console.log(
      `  ${unblockedUncovered.length} call site(s) of helpers that translate only in closures they return or through the helpers above`
    )
  }
  if (argv.includes('--list')) {
    for (const { use, entry } of uncovered) {
      const line =
        use.identifier.getSourceFile().getLineAndCharacterOfPosition(use.identifier.getStart())
          .line + 1
      console.log(
        `${use.rel}:${line} ${entry.id} ${entry.blocked.join('; ') || 'translates only in returned closures or via unthreadable helpers'}`
      )
    }
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
