#!/usr/bin/env node
// Live check of every app in BOT_MCP_APPS. Usage: node bot-app-catalog-smoke.mjs [report.json]
import { writeFileSync } from 'node:fs'
import { BOT_MCP_APPS } from '../../../src/shared/bots/bot-mcp-apps.ts'
import { checkApp } from './app-kind-check.mjs'
import { createGuardedClient } from './guarded-request.mjs'

const reportPath = process.argv[2]
const results = []
for (const app of BOT_MCP_APPS) {
  const result = await checkApp(app, createGuardedClient({ postUrl: app.url }))
  results.push(result)
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'} ${app.id} [${app.signIn}] ${app.url}\n     ${result.detail}`
  )
}

const failed = results.filter((result) => !result.ok)
console.log(`${results.length - failed.length}/${results.length} apps pass`)
if (reportPath) {
  writeFileSync(
    reportPath,
    `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`
  )
}
process.exitCode = failed.length > 0 ? 1 : 0
