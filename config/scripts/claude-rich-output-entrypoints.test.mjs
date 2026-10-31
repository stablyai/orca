import { runProcessSync } from '@orca/process-host'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  cleanupClaudeRichOutputBuildFixtures,
  createClaudeRichOutputBuildFixture
} from './claude-rich-output-build-test-fixture.mjs'

const scripts = import.meta.dirname
afterEach(cleanupClaudeRichOutputBuildFixtures)

test('ordinary workspace preparation succeeds when the optional rich deployment is unavailable', () => {
  const { root, put } = createClaudeRichOutputBuildFixture()
  put(
    'config/scripts/build-workspace-packages.mjs',
    readFileSync(join(scripts, 'build-workspace-packages.mjs'))
  )
  put(
    'config/scripts/build-claude-rich-output.mjs',
    "throw new Error('optional rich deployment unavailable')"
  )
  put('src/packages/process-host/package.json', '{"name":"@orca/process-host"}')
  for (const name of ['typescript', 'tsx', '@types/node']) {
    put(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '0.0.0' }))
  }
  put(
    'package-builder.cjs',
    `
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dist = join(process.cwd(), 'src/packages/process-host/dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'index.js'), 'export const built = true');
`
  )
  const run = (name) =>
    runProcessSync({
      program: process.execPath,
      args: [join(root, 'config/scripts', name)],
      cwd: root,
      env: { ...process.env, npm_execpath: join(root, 'package-builder.cjs') },
      timeoutMs: 30_000
    })
  const ordinary = run('build-workspace-packages.mjs')
  expect(ordinary.code, ordinary.stderr).toBe(0)
  expect(existsSync(join(root, 'src/packages/process-host/dist/index.js'))).toBe(true)
  const explicit = run('build-claude-rich-output.mjs')
  expect(explicit.code).not.toBe(0)
  expect(explicit.stderr).toContain('optional rich deployment unavailable')
})

test('the explicit renderer runner reports a timeout and termination signal', () => {
  const { root, put } = createClaudeRichOutputBuildFixture()
  for (const name of ['test-claude-rich-output.mjs', 'process-failure-message.mjs']) {
    put(`config/scripts/${name}`, readFileSync(join(scripts, name)))
  }
  put('resources/claude-rich-output/reply-markdown/hooks/fixture.test.mjs', '')
  put(
    'node_modules/@orca/process-host/index.js',
    `
export function runProcessSync({ timeoutMs }) {
  if (timeoutMs !== 180000) throw new Error('runner deadline changed');
  return { code: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '' };
}`
  )
  const result = runProcessSync({
    program: process.execPath,
    args: [join(root, 'config/scripts/test-claude-rich-output.mjs')],
    cwd: root,
    timeoutMs: 30_000
  })
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('timed out')
  expect(result.stderr).toContain('SIGTERM')
  expect(result.stderr).not.toContain('undefined')
})
