import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'
import { expect, it } from 'vitest'
import { createWorkspaceSourceResolver } from '../../../config/scripts/workspace/source-exports/workspace-source-exports.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const workspace = createWorkspaceSourceResolver(root)

function eagerClosure(entry: string): Set<string> {
  const files = new Set([path.resolve(root, entry)])
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
    for (const statement of source.statements) {
      let specifier: string | undefined
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause
        const bindings = clause?.namedBindings
        if (
          clause?.isTypeOnly ||
          (clause &&
            !clause.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly))
        ) {
          continue
        }
        specifier = statement.moduleSpecifier.text
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.length > 0 &&
          statement.exportClause.elements.every((element) => element.isTypeOnly)
        ) {
          continue
        }
        specifier = statement.moduleSpecifier.text
      }
      if (!specifier) {
        continue
      }
      const target = specifier.startsWith('.')
        ? path.resolve(path.dirname(file), specifier)
        : workspace.resolve(specifier)?.path
      if (!target) {
        continue
      }
      const resolved = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].find(
        (extension) => statSync(target + extension, { throwIfNoEntry: false })?.isFile()
      )
      if (resolved !== undefined) {
        files.add(target + resolved)
      }
    }
  }
  return new Set([...files].map((file) => path.relative(root, file).split(path.sep).join('/')))
}

it('keeps server entry, activation and profile initialization in their own phases', () => {
  const entry = eagerClosure('src/main/orcad/host-runtime/orcad-entry.ts')
  expect(entry.has('src/main/backend/core-runtime-activation.ts')).toBe(false)
  const activation = eagerClosure('src/main/backend/core-runtime-activation.ts')
  for (const phase of [entry, activation]) {
    expect(phase.has('src/main/runtime/construction/desktop-workspace-services.ts')).toBe(false)
    expect(phase.has('src/main/orcad/profile-state/orcad-profile-state-startup.ts')).toBe(false)
  }
})
