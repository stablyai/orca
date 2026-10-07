import { globSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import ts from 'typescript-api'
import { expect, it } from 'vitest'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { NODE_RUNTIME_INCLUDE } from './vitest-node-runtime-files.mjs'

const sqliteHarnesses = new Set([
  'persistence-test-harness',
  'agent-session-record-store-test-harness',
  'journal-host-database-test-support'
])
const sqliteModules = new Set([
  resolve('src/main/sqlite/sync-database'),
  resolve('src/main/native-chat/agent-session-journal/journal-host-database'),
  resolve('src/main/runtime/orchestration/db'),
  resolve('src/main/runtime/orchestration/db/orchestration-db'),
  resolve('src/main/runtime/structured-agent-session-runtime'),
  resolve('src/main/runtime/agent-session-record-store-slot')
])

/** Type-only names do not erase a default binding or an empty import's side effects. */
function importsSqliteRuntime(file: string, source: string): boolean {
  const module = ts.createSourceFile(file, source, ts.ScriptTarget.Latest)
  return module.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return false
    }
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (
      clause?.isTypeOnly ||
      (!clause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((name) => name.isTypeOnly))
    ) {
      return false
    }
    return (
      sqliteHarnesses.has(
        basename(statement.moduleSpecifier.text).replace(/\.[cm]?[jt]sx?$/, '')
      ) ||
      sqliteModules.has(
        resolve(
          dirname(resolve(file)),
          statement.moduleSpecifier.text.replace(/\.[cm]?[jt]sx?$/, '')
        )
      )
    )
  })
}

it.each([
  ['import Database, { type Options } from "./sync-database"', true],
  ['import {} from "./sync-database"', true],
  ['import "./sync-database"', true],
  ['import { Database } from "./sync-database"', true],
  ['import * as Database from "./sync-database"', true],
  ['import type Database from "./sync-database"', false],
  ['import type { Options } from "./sync-database"', false],
  ['import { type Options } from "./sync-database"', false]
])('classifies the runtime dependency in %s', (source, runtime) => {
  expect(importsSqliteRuntime('src/main/sqlite/example.test.ts', source)).toBe(runtime)
})

it('keeps real SQLite fixtures and database consumers in the Node runtime project', () => {
  const root = process.cwd()
  const nodeFiles = new Set(globSync(NODE_RUNTIME_INCLUDE).map((file) => resolve(root, file)))
  const missing: string[] = []
  for (const file of discoverUnitFiles(root)) {
    const source = readFileSync(resolve(root, file), 'utf8')
    if (
      ![...sqliteHarnesses].some((name) => source.includes(name)) &&
      !source.includes('sync-database') &&
      !source.includes('journal-host-database') &&
      !source.includes('structured-agent-session-runtime') &&
      !source.includes('agent-session-record-store-slot') &&
      !source.includes('db')
    ) {
      continue
    }
    if (importsSqliteRuntime(file, source) && !nodeFiles.has(resolve(root, file))) {
      missing.push(file)
    }
  }
  expect(missing).toEqual([])
})
