import { runProcessSync } from '@orca/process-host'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'

const scripts = import.meta.dirname
const directories = []
export function cleanupClaudeRichOutputBuildFixtures() {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function createClaudeRichOutputBuildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rich-output-cache-'))
  directories.push(root)
  const put = (name, source) => {
    const file = join(root, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  for (const name of [
    'build-claude-rich-output.mjs',
    'claude-rich-output-build-lock.mjs',
    'claude-rich-output-source-hash.mjs',
    'pnpm-cli-invocation.mjs'
  ]) {
    put(`config/scripts/${name}`, readFileSync(join(scripts, name)))
  }
  put(
    'src/shared/claude-rich-output-artifacts.ts',
    readFileSync(join(scripts, '../../src/shared/claude-rich-output-artifacts.ts'))
  )
  put('pnpm-lock.yaml', 'fixture lock')
  put('resources/claude-rich-output/foo', 'barvalue')
  put(
    'node_modules/esbuild/package.json',
    JSON.stringify({ type: 'module', exports: './index.js' })
  )
  put('node_modules/esbuild/index.js', 'export async function build() {}')
  put(
    'node_modules/proper-lockfile/package.json',
    JSON.stringify({ type: 'module', exports: './index.js' })
  )
  put(
    'node_modules/proper-lockfile/index.js',
    `export { default } from ${JSON.stringify(import.meta.resolve('proper-lockfile'))}`
  )
  put(
    'node_modules/@orca/process-host/package.json',
    JSON.stringify({ type: 'module', exports: './index.js' })
  )
  put(
    'node_modules/@orca/process-host/index.js',
    `import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function runProcessSync({ args }) {
  const root = process.cwd();
  const output = args.at(-1);
  rmSync(output, { recursive: true, force: true });
  cpSync(join(root, 'resources/claude-rich-output'), output, { recursive: true });
  mkdirSync(join(output, 'node_modules/@mathjax/src'), { recursive: true });
  mkdirSync(join(output, 'node_modules/@mathjax/src/bundle'), { recursive: true });
  writeFileSync(join(output, 'node_modules/@mathjax/src/bundle/node-main.js'), 'fixture dependency');
  mkdirSync(join(output, 'node_modules/@mathjax/mathjax-newcm-font'), { recursive: true });
  appendFileSync(join(root, 'deploy.log'), 'deploy\\n');
  return { code: 0 };
}
export async function runProcess(options) { return runProcessSync(options) }`
  )
  const runBuild = (env = process.env) =>
    runProcessSync({
      program: process.execPath,
      args: [join(root, 'config/scripts/build-claude-rich-output.mjs')],
      cwd: root,
      env,
      timeoutMs: 30_000
    })
  const build = () => {
    const result = runBuild()
    expect(result.code, result.stderr).toBe(0)
  }
  const deployments = () => readFileSync(join(root, 'deploy.log'), 'utf8').trim().split('\n').length
  return { root, put, build, runBuild, deployments }
}
