import { runProcess, runProcessSync } from '@orca/process-host'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'

import {
  createClaudeRichOutputBuildFixture as fixture,
  cleanupClaudeRichOutputBuildFixtures
} from './claude-rich-output-build-test-fixture.mjs'

const scripts = import.meta.dirname
afterEach(cleanupClaudeRichOutputBuildFixtures)

test.each(['cjs', 'mjs'])('deploys through npm_execpath without PATH pnpm (%s)', (extension) => {
  const { root, put, runBuild, deployments } = fixture()
  put('fixture-deploy.mjs', readFileSync(join(root, 'node_modules/@orca/process-host/index.js')))
  put(
    'node_modules/@orca/process-host/index.js',
    `export { runProcess, runProcessSync } from ${JSON.stringify(import.meta.resolve('@orca/process-host'))}`
  )
  const entry = join(root, 'pnpm entry', `pnpm.${extension}`)
  put(
    `pnpm entry/pnpm.${extension}`,
    `import(${JSON.stringify(pathToFileURL(join(root, 'fixture-deploy.mjs')).href)}).then(
  ({ runProcessSync }) => { process.exitCode = runProcessSync({ args: process.argv.slice(2) }).code }
)`
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH')
  )

  const result = runBuild({ ...env, PATH: join(root, 'empty-bin'), npm_execpath: entry })

  expect(result.code, result.stderr).toBe(0)
  expect(deployments()).toBe(1)
  expect(readFileSync(join(root, 'out/claude-rich-output/foo'), 'utf8')).toBe('barvalue')
  expect(
    JSON.parse(readFileSync(join(root, 'out/claude-rich-output/manifest.json'), 'utf8')).assets
  ).toContain('claude-rich-output/foo')
})

test.each(['deploy', 'bundle'])(
  'concurrent builders serialize the entire %s phase and reuse the completed bundle',
  async (phase) => {
    const { root, put, deployments } = fixture()
    put(
      'node_modules/@orca/process-host/index.js',
      `export { runProcess, runProcessSync } from ${JSON.stringify(import.meta.resolve('@orca/process-host'))}`
    )
    put(
      'fixture-deploy.mjs',
      `import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
writeFileSync(join(root, 'active'), 'deploy', { flag: 'wx' });
writeFileSync(join(root, 'deploy-entered'), '');
if (process.env.BUILD_PHASE === 'deploy') {
  const deadline = Date.now() + 15000;
  while (!existsSync(join(root, 'release'))) {
    if (Date.now() > deadline) throw new Error('deployment gate timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const output = process.argv.at(-1);
rmSync(output, { recursive: true, force: true });
cpSync(join(root, 'resources/claude-rich-output'), output, { recursive: true });
mkdirSync(join(output, 'node_modules/@mathjax/src'), { recursive: true });
mkdirSync(join(output, 'node_modules/@mathjax/mathjax-newcm-font'), { recursive: true });
appendFileSync(join(root, 'deploy.log'), 'deploy\\n');`
    )
    put(
      'node_modules/esbuild/index.js',
      `import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
export async function build({ outfile }) {
  const root = process.cwd();
  writeFileSync(join(root, 'bundle-entered'), '');
  if (process.env.BUILD_PHASE === 'bundle') {
    const deadline = Date.now() + 15000;
    while (!existsSync(join(root, 'release'))) {
      if (Date.now() > deadline) throw new Error('bundle gate timed out');
      await setTimeout(10);
    }
  }
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, 'complete renderer');
  rmSync(join(root, 'active'), { force: true });
}`
    )
    put(
      'fixture-builder.mjs',
      `import { writeFileSync } from 'node:fs';
import './node_modules/esbuild/index.js';
import './node_modules/@orca/process-host/index.js';
writeFileSync(process.argv[2], '');
await import('./config/scripts/build-claude-rich-output.mjs');`
    )
    const children = []
    const start = (name) => {
      const child = runProcess({
        program: process.execPath,
        args: [join(root, 'fixture-builder.mjs'), join(root, `${name}-ready`)],
        cwd: root,
        env: { ...process.env, BUILD_PHASE: phase, npm_execpath: join(root, 'fixture-deploy.mjs') },
        timeoutMs: 25_000
      })
      children.push(child)
      return child
    }
    const waitFor = async (name) => {
      await expect.poll(() => existsSync(join(root, name)), { timeout: 10_000 }).toBe(true)
    }
    try {
      start('first')
      await waitFor(`${phase}-entered`)
      const second = start('second')
      await waitFor('second-ready')
      const outcome = await Promise.race([
        second.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000))
      ])
      expect(outcome).toBe('blocked')
    } finally {
      put('release', '')
      const results = await Promise.all(children)
      for (const result of results) {
        expect(result.code, result.stderr).toBe(0)
      }
    }
    expect(deployments()).toBe(1)
    expect(
      readFileSync(join(root, 'out/claude-rich-output/reply-media/render/process.mjs'), 'utf8')
    ).toBe('complete renderer')
    const manifest = JSON.parse(
      readFileSync(join(root, 'out/claude-rich-output/manifest.json'), 'utf8')
    )
    expect(manifest.assets).toContain('claude-rich-output/reply-media/render/process.mjs')
    expect(existsSync(join(root, 'out/.claude-rich-output-build.lock'))).toBe(false)
  }
)

test('a cached workspace package build still refreshes changed rich-output resources', () => {
  const { root, put, deployments, runBuild } = fixture()
  put(
    'config/scripts/build-workspace-packages.mjs',
    readFileSync(join(scripts, 'build-workspace-packages.mjs'))
  )
  put('src/packages/process-host/package.json', '{"name":"@orca/process-host"}')
  put('src/packages/process-host/source.ts', 'export const fixture = true')
  for (const name of ['typescript', 'tsx', '@types/node']) {
    put(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '0.0.0' }))
  }
  put(
    'package-builder.cjs',
    `const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.cwd();
const dist = join(root, 'src/packages/process-host/dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'index.js'), 'export const built = true');
appendFileSync(join(root, 'package-build.log'), 'build\\n');`
  )
  const build = () => {
    const result = runProcessSync({
      program: process.execPath,
      args: [join(root, 'config/scripts/build-workspace-packages.mjs')],
      cwd: root,
      env: { ...process.env, npm_execpath: join(root, 'package-builder.cjs') },
      timeoutMs: 30_000
    })
    expect(result.code, result.stderr).toBe(0)
    const rich = runBuild()
    expect(rich.code, rich.stderr).toBe(0)
  }
  build()
  expect(existsSync(join(root, 'out/claude-rich-output/manifest.json'))).toBe(true)
  put('resources/claude-rich-output/foo', 'updated')
  build()
  expect(readFileSync(join(root, 'package-build.log'), 'utf8')).toBe('build\n')
  expect(deployments()).toBe(2)
  expect(readFileSync(join(root, 'out/claude-rich-output/foo'), 'utf8')).toBe('updated')
})

test('the build rejects an unsafe dependency filename before publishing its manifest', () => {
  const { root, put, runBuild } = fixture()
  put('resources/claude-rich-output/notes with spaces.txt', 'dependency asset')
  const result = runBuild()
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('Unsafe Claude rich output asset path')
  expect(result.stderr).toContain('notes with spaces.txt')
  expect(existsSync(join(root, 'out/claude-rich-output/manifest.json'))).toBe(false)
})

test('a filename/content boundary collision deploys the new files instead of retaining stale output', () => {
  const { root, put, build, deployments } = fixture()
  build()
  expect(readFileSync(join(root, 'out/claude-rich-output/foo'), 'utf8')).toBe('barvalue')
  rmSync(join(root, 'resources/claude-rich-output/foo'))
  put('resources/claude-rich-output/foobar', 'value')
  build()
  expect(deployments()).toBe(2)
  expect(existsSync(join(root, 'out/claude-rich-output/foo'))).toBe(false)
  expect(readFileSync(join(root, 'out/claude-rich-output/foobar'), 'utf8')).toBe('value')
})

test('unchanged inputs reuse the deployment, while changed content refreshes it', () => {
  const { root, put, build, deployments } = fixture()
  build()
  build()
  expect(deployments()).toBe(1)
  put('resources/claude-rich-output/foo', 'updated')
  build()
  expect(deployments()).toBe(2)
  expect(readFileSync(join(root, 'out/claude-rich-output/foo'), 'utf8')).toBe('updated')
})

test('a failed bundle releases ownership and the next build repairs the incomplete output', () => {
  const { root, put, build, runBuild, deployments } = fixture()
  put(
    'node_modules/esbuild/index.js',
    "export async function build() { throw new Error('bundle failed') }"
  )
  const failed = runBuild()
  expect(failed.code).not.toBe(0)
  expect(failed.stderr).toContain('bundle failed')
  expect(existsSync(join(root, 'out/.claude-rich-output-build.lock'))).toBe(false)
  expect(existsSync(join(root, 'out/claude-rich-output/manifest.json'))).toBe(false)

  put('node_modules/esbuild/index.js', 'export async function build() {}')
  build()

  expect(deployments()).toBe(2)
  expect(readFileSync(join(root, 'out/claude-rich-output/foo'), 'utf8')).toBe('barvalue')
  expect(existsSync(join(root, 'out/claude-rich-output/manifest.json'))).toBe(true)
  expect(existsSync(join(root, 'out/.claude-rich-output-build.lock'))).toBe(false)
})

test.each([
  ['plugin directory', 'reply-markdown', 'reply-markdown/hooks/register.tsx', false],
  ['media entry', 'reply-media/hooks/register.tsx', 'reply-media/hooks/register.tsx', false],
  [
    'renderer dependency',
    'node_modules/@mathjax/src/bundle/node-main.js',
    'node_modules/@mathjax/src/bundle/node-main.js',
    false
  ],
  [
    'entry replaced by a directory',
    'reply-markdown/hooks/register.tsx',
    'reply-markdown/hooks/register.tsx',
    true
  ]
])('repairs cached output after losing a %s', (_name, missing, restored, replaceWithDirectory) => {
  const { root, put, build, deployments } = fixture()
  for (const name of ['reply-markdown', 'reply-media']) {
    put(`resources/claude-rich-output/${name}/.claude-plugin/plugin.json`, JSON.stringify({ name }))
    put(`resources/claude-rich-output/${name}/hooks/register.tsx`, `export const name = '${name}'`)
  }
  build()
  const output = join(root, 'out/claude-rich-output')
  const marker = readFileSync(join(output, '.source-hash'), 'utf8')
  const expected = readFileSync(join(output, restored), 'utf8')
  rmSync(join(output, missing), { recursive: true, force: true })
  if (replaceWithDirectory) {
    mkdirSync(join(output, missing))
  }
  expect(readFileSync(join(output, '.source-hash'), 'utf8')).toBe(marker)

  build()

  expect(deployments()).toBe(2)
  expect(readFileSync(join(output, restored), 'utf8')).toBe(expected)
  expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')).assets).toContain(
    `claude-rich-output/${restored}`
  )
})

for (const name of [
  'pnpm-lock.yaml',
  'config/scripts/build-claude-rich-output.mjs',
  'config/scripts/claude-rich-output-build-lock.mjs',
  'config/scripts/claude-rich-output-source-hash.mjs',
  'config/scripts/pnpm-cli-invocation.mjs'
]) {
  test(`changing deployment input ${name} refreshes the bundle`, () => {
    const { root, build, deployments } = fixture()
    build()
    appendFileSync(join(root, name), '\n// fixture change\n')
    build()
    expect(deployments()).toBe(2)
  })
}
