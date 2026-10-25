import { isAbsolute, relative, resolve } from 'node:path'
import { parseCLI } from 'vitest/node'

export function vitestCliFileFilters(argv = process.argv) {
  if (!/[/\\]vitest[/\\](?:vitest\.mjs|dist[/\\]cli\.js)$/.test(argv[1] ?? '')) {
    return []
  }
  try {
    const parsed = parseCLI(['vitest', ...argv.slice(2)], { allowUnknownOptions: true })
    if (parsed.options.watch || !(argv[2] === 'run' || parsed.options.run)) {
      return []
    }
    return parsed.filter.map((filter) => filter.replace(/:\d+(?:-\d+)?$/, ''))
  } catch {
    return []
  }
}

export function matchesVitestFileFilters(file, filters, root) {
  if (!filters.length) {
    return true
  }
  const normalized = file.replaceAll('\\', '/').toLocaleLowerCase()
  return filters.some((filter) => {
    const normalizedFilter = filter.replaceAll('\\', '/').toLocaleLowerCase()
    const relativeFilter = relative(root, resolve(root, filter))
      .replaceAll('\\', '/')
      .toLocaleLowerCase()
    return (
      normalized.includes(normalizedFilter) ||
      normalized.includes(relativeFilter) ||
      (isAbsolute(filter) && resolve(root, file).startsWith(filter))
    )
  })
}
