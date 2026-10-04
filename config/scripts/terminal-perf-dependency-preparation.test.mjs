import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { runProcessSync } from './script-child-process.mjs'

const workflow = parse(readFileSync('.github/workflows/terminal-perf.yml', 'utf8'))
const steps = workflow.jobs['terminal-perf'].steps
const selector = steps.find((step) => step.id === 'install-mode')
const script = selector.run.trim().match(/^node <<'NODE'\n([\s\S]*)\nNODE$/)[1]
const supportedAction = readFileSync('.github/actions/install-node-dependencies/action.yml', 'utf8')
const supportedManifest = {
  engines: { node: '24' },
  packageManager: 'pnpm@12.8.1',
  scripts: { postinstall: 'node config/scripts/rebuild-native-deps.mjs' }
}

function select(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-terminal-preparation-'))
  const output = join(directory, 'output')
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify(options.manifest ?? supportedManifest)
    )
    for (const [file, content] of [
      ['.github/actions/install-node-dependencies/action.yml', options.action ?? supportedAction],
      ['.github/actions/prepare-native-runtime/action.yml', 'runs: {}'],
      ['config/scripts/ensure-native-runtime.mjs', '']
    ]) {
      if (options.missing === file) {
        continue
      }
      const path = join(directory, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    const result = runProcessSync({
      program: process.execPath,
      args: ['-e', script],
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        RUNNER_KIND: options.kind ?? 'github-hosted',
        JOB_CONTAINER: options.container ?? '',
        RUNNER_OS: options.os ?? 'Linux',
        RUNNER_ARCH: options.arch ?? 'X64'
      }
    })
    expect(result.code, result.stderr || result.stdout).toBe(0)
    return readFileSync(output, 'utf8').trim()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it('selects the measured current root profile with the actual installer metadata', () => {
  expect(select()).toBe('shared=true')
  expect(
    select({ manifest: { ...supportedManifest, packageManager: 'pnpm@12.8.1+sha512.fixture' } })
  ).toBe('shared=true')
})

it.each([
  ['historical Node', { manifest: { ...supportedManifest, engines: { node: '22' } } }],
  ['historical pnpm', { manifest: { ...supportedManifest, packageManager: 'pnpm@10.0.0' } }],
  ['unmeasured pnpm', { manifest: { ...supportedManifest, packageManager: 'pnpm@12.8.10' } }],
  ['missing toolchain', { manifest: {} }],
  [
    'extra lifecycle work',
    { manifest: { ...supportedManifest, scripts: { postinstall: 'generate' } } }
  ],
  ['self-hosted runner', { kind: 'self-hosted' }],
  ['job container', { container: 'container-id' }],
  ['another OS', { os: 'Windows' }],
  ['another architecture', { arch: 'ARM64' }],
  ['missing installer', { missing: '.github/actions/install-node-dependencies/action.yml' }],
  ['missing native action', { missing: '.github/actions/prepare-native-runtime/action.yml' }],
  ['missing runtime script', { missing: 'config/scripts/ensure-native-runtime.mjs' }],
  ['old installer interface', { action: 'inputs:\n  native-runtime: {}\nruns: {}\n' }],
  [
    'output-only names',
    { action: 'outputs:\n  native-runtime: {}\n  cache-pnpm-store-lookup-only: {}\n' }
  ]
])('retains the original install for %s', (_name, options) => {
  expect(select(options)).toBe('shared=false')
})

it.each(['true', 'false', ''])('routes mode %s to one complete preparation path', (shared) => {
  const enabled = (step) =>
    runInNewContext(step.if.replaceAll('steps.install-mode.outputs.shared', 'shared'), { shared })
  const current = steps.find((step) => step.name === 'Prepare current dependencies')
  const legacy = steps.filter((step) =>
    [
      'Setup pnpm',
      'Setup Node.js',
      "Use external node-gyp to avoid pnpm's bundled copy",
      'Install dependencies'
    ].includes(step.name)
  )
  expect(legacy).toHaveLength(4)
  expect(enabled(current)).toBe(shared === 'true')
  expect(legacy.every((step) => enabled(step) === (shared !== 'true'))).toBe(true)
  expect(current.with).toEqual({
    'native-runtime': 'electron',
    'cache-electron-package': 'true',
    'cache-pnpm-store-lookup-only': 'true'
  })
  expect(legacy.at(-1).run).toBe('pnpm install --frozen-lockfile')
  expect(steps.find((step) => step.name === 'Run terminal scale perf report gate').run).toContain(
    'pnpm run test:e2e:terminal-perf:scale:report'
  )
})
