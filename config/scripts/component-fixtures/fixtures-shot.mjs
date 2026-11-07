#!/usr/bin/env node
// Usage: pnpm fixtures:shot <id|glob>... [--theme dark|light|both] [--scale 2] [--out dir]
//        pnpm fixtures:shot --list | --stop
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  callFixtureServer,
  ensureFixtureServer,
  stopFixtureServer
} from './fixture-server-client.mjs'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: 'string', default: 'dark' },
    scale: { type: 'string', default: '1' },
    out: { type: 'string' },
    list: { type: 'boolean', default: false },
    stop: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }
  }
})

async function main() {
  if (values.stop) {
    console.log(
      (await stopFixtureServer()) ? 'Fixture server stopped.' : 'No fixture server running.'
    )
    return
  }
  if (!values.list && positionals.length === 0) {
    console.error(
      'Usage: pnpm fixtures:shot <id|glob>... [--theme dark|light|both] | --list | --stop'
    )
    process.exitCode = 2
    return
  }
  const startedAt = performance.now()
  const server = await ensureFixtureServer({
    onStart: () => console.error('[fixtures] starting server (first run takes a few seconds)…')
  })
  if (values.list) {
    const { fixtures } = await callFixtureServer(server.url, 'list')
    for (const fixture of fixtures) {
      console.log(values.json ? JSON.stringify(fixture) : `${fixture.id}\t${fixture.file}`)
    }
    return
  }
  const payload = await callFixtureServer(server.url, 'shot', {
    ids: positionals,
    theme: values.theme,
    scale: Number(values.scale),
    outDir: values.out ? path.resolve(values.out) : undefined
  })
  if (
    payload.error ||
    payload.results?.some((result) => result.error || result.pageErrors?.length)
  ) {
    process.exitCode = 1
  }
  if (values.json) {
    console.log(JSON.stringify({ ...payload, totalMs: Math.round(performance.now() - startedAt) }))
    return
  }
  if (payload.error) {
    console.error(payload.error)
    console.error(`Known fixtures: ${payload.knownIds?.join(', ')}`)
    process.exitCode = 1
    return
  }
  for (const result of payload.results) {
    if (result.error) {
      console.error(`FAIL ${result.id} [${result.theme}]: ${result.error}`)
      process.exitCode = 1
    } else {
      console.log(path.relative(process.cwd(), result.path))
    }
    for (const pageError of result.pageErrors ?? []) {
      console.error(`  page error (${result.id}): ${pageError.split('\n')[0]}`)
    }
  }
  const totalMs = Math.round(performance.now() - startedAt)
  console.error(
    `[fixtures] ${payload.results.length} shot(s) in ${totalMs}ms${server.started ? ' (cold start)' : ''}`
  )
}

main().catch((error) => {
  console.error(error?.message ?? error)
  process.exitCode = 1
})
