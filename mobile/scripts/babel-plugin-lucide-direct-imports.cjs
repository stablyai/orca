const fs = require('node:fs')
const path = require('node:path')

let cachedIconMap = null

function getLucideIconMap() {
  if (cachedIconMap) {
    return cachedIconMap
  }
  const map = new Map()
  const entryPath = fs.realpathSync(
    path.resolve(
      __dirname,
      '..',
      'node_modules',
      'lucide-react-native',
      'dist',
      'esm',
      'lucide-react-native.mjs'
    )
  )
  const source = fs.readFileSync(entryPath, 'utf8')
  const lineRe = /^export \{ ([^}]+) \} from '\.\/icons\/([^']+)';$/gm
  for (const match of source.matchAll(lineRe)) {
    const specifiers = match[1]
    const iconFile = match[2]
    for (const part of specifiers.split(',')) {
      const m = part.trim().match(/^default as (\w+)$/)
      if (m) {
        map.set(m[1], iconFile)
      }
    }
  }
  cachedIconMap = map
  return map
}

// Metro does not tree-shake `lucide-react-native`'s 1,700-icon barrel; rewrite icon imports to direct files.
module.exports = function lucideDirectImportsPlugin({ types: t }) {
  return {
    name: 'lucide-direct-imports',
    visitor: {
      ImportDeclaration(importPath) {
        const { node } = importPath
        if (node.source.value !== 'lucide-react-native' || node.importKind === 'type') {
          return
        }
        const iconMap = getLucideIconMap()
        const replacements = []
        const remaining = []

        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && spec.importKind !== 'type') {
            const importedName =
              spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
            const iconFile = iconMap.get(importedName)
            if (iconFile) {
              replacements.push(
                t.importDeclaration(
                  [t.importDefaultSpecifier(t.identifier(spec.local.name))],
                  t.stringLiteral(`lucide-react-native/dist/esm/icons/${iconFile}`)
                )
              )
              continue
            }
          }
          remaining.push(spec)
        }

        if (replacements.length === 0) {
          return
        }
        if (remaining.length > 0) {
          replacements.push(t.importDeclaration(remaining, t.stringLiteral('lucide-react-native')))
        }
        importPath.replaceWithMultiple(replacements)
      }
    }
  }
}
