import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { importsSqliteRuntime } from './vitest-sqlite-runtime-scan.mjs'

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

it.each([
  'src/main/runtime/editor-view-layout-apply.test.ts',
  'src/main/runtime/restored-editor-move-restart.test.ts',
  'src/main/runtime/workspaces/persisted-surfaces/sweep-terminal-placement.test.ts'
])('routes the real topology SQLite fixture consumer to Node: %s', (file) => {
  expect(importsSqliteRuntime(file, readFileSync(file, 'utf8'))).toBe(true)
})
