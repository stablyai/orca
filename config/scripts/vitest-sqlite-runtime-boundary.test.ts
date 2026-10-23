import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { importsSqliteRuntime, SQLITE_MODULES } from './vitest-sqlite-runtime-scan.mjs'

// A moved module would silently send its importers back to Bun.
it.each(SQLITE_MODULES)('scans for a SQLite module that still exists: %s', (module) => {
  expect(existsSync(`${module}.ts`)).toBe(true)
})

it.each([
  ['import { createRestTestRig } from "./structured-agent-session-rest-test-rig"', true],
  ['import type { RestTestRig } from "./structured-agent-session-rest-test-rig"', false],
  ['import Database, { type Options } from "./sync-database"', true],
  ['import {} from "./sync-database"', true],
  ['import "./sync-database"', true],
  ['import { Database } from "./sync-database"', true],
  ['import * as Database from "./sync-database"', true],
  ['import { OrchestrationDb } from "../runtime/orchestration/db"', true],
  ['import type Database from "./sync-database"', false],
  ['import type { Options } from "./sync-database"', false],
  ['import { type Options } from "./sync-database"', false]
])('classifies the runtime dependency in %s', (source, runtime) => {
  expect(importsSqliteRuntime('src/main/sqlite/example.test.ts', source)).toBe(runtime)
})
