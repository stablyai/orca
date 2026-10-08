import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'

const require = createRequire(import.meta.url)
const editorEntry = require.resolve('monaco-editor/esm/vs/editor/editor.main.js')
export const associationsPath = fileURLToPath(
  new URL('../../src/shared/monaco-language-associations.json', import.meta.url)
)

// Monaco omits common Ruby task, template and configuration files.
const rubyAssociations = {
  extensions: ['.rake', '.ru', '.jbuilder', '.thor'],
  filenames: ['Guardfile', 'Capfile', 'Podfile', 'Brewfile', 'Vagrantfile']
}

// Read registration metadata without importing Monaco or executing its grammar loaders.
export function readMonacoAssociations() {
  const entry = ts.createSourceFile(
    editorEntry,
    readFileSync(editorEntry, 'utf8'),
    ts.ScriptTarget.Latest
  )
  const files = entry.statements
    .filter(ts.isImportDeclaration)
    .map((node) => node.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .map((node) => node.text)
    .filter((path) => path.endsWith('.contribution.js'))
  const registrations = []
  for (const file of files) {
    const path = resolve(dirname(editorEntry), file)
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest)
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ['registerLanguage', 'languages.register'].includes(node.expression.getText(source))
      ) {
        const [argument] = node.arguments
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
          throw new Error(`Unsupported Monaco registration in ${file}`)
        }
        const metadata = { id: '', extensions: [], filenames: [] }
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property)) {
            continue
          }
          const key = property.name.getText(source)
          if (!['id', 'extensions', 'filenames'].includes(key)) {
            continue
          }
          const value = property.initializer
          if (key === 'id' && ts.isStringLiteral(value)) {
            metadata.id = value.text
          } else if (key !== 'id' && ts.isArrayLiteralExpression(value)) {
            metadata[key] = value.elements.map((element) => {
              if (!ts.isStringLiteral(element)) {
                throw new Error(`Nonliteral association in ${file}`)
              }
              return element.text
            })
          } else {
            throw new Error(`Unsupported ${key} in ${file}`)
          }
        }
        if (!metadata.id) {
          throw new Error(`Missing language id in ${file}`)
        }
        if (metadata.id === 'ruby') {
          metadata.extensions = [
            ...new Set([...metadata.extensions, ...rubyAssociations.extensions])
          ]
          metadata.filenames = [...new Set([...metadata.filenames, ...rubyAssociations.filenames])]
        }
        registrations.push(metadata)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  if (registrations.length < 80) {
    throw new Error('Monaco registration entry point changed')
  }
  return registrations
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  writeFileSync(associationsPath, `${JSON.stringify(readMonacoAssociations(), null, 2)}\n`)
}
