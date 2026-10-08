import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from './script-child-process.mjs'

const action = parse(readFileSync('.github/actions/install-node-dependencies/action.yml', 'utf8'))
const mode = action.runs.steps.find((step) => step.id === 'pnpm-store-mode')
const defaultContext = {
  github: { event_name: 'push' },
  runner: { os: 'Linux', arch: 'X64', environment: 'github-hosted' },
  job: { container: { id: '' } },
  inputs: {
    'cache-pnpm-store': 'true',
    'cache-pnpm-store-lookup-only': 'auto',
    'cache-dependency-path': 'pnpm-lock.yaml',
    'node-version': ''
  }
}
const expression = mode.if.replaceAll(/inputs\.([\w-]+)/g, 'inputs["$1"]')

function eligible(changes) {
  const context = structuredClone(defaultContext)
  for (const [name, fields] of Object.entries(changes)) {
    Object.assign(context[name], fields)
  }
  return runInNewContext(expression, context)
}

function resolveMode(request, node, manager) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-store-mode-'))
  const output = join(directory, 'output')
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ engines: { node }, packageManager: manager })
    )
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-o', 'pipefail', '-c', mode.run],
      cwd: directory,
      env: { ...process.env, LOOKUP_REQUEST: request, GITHUB_OUTPUT: output }
    })
    expect(result.code, result.stderr || result.stdout).toBe(0)
    return readFileSync(output, 'utf8')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('automatic pnpm store mode', () => {
  it.each([
    ['auto', '24', 'pnpm@12.8.1', '', true],
    ['auto', '25', 'pnpm@12.8.1', 'pnpm', false],
    ['auto', '24', 'pnpm@13.0.0', 'pnpm', false],
    ['true', '25', 'pnpm@13.0.0', '', true]
  ])(
    'routes resolved %s mode for Node %s / %s into both cache steps',
    (request, node, manager, cache, lookup) => {
      const context = structuredClone(defaultContext)
      context.inputs['cache-pnpm-store-lookup-only'] = request
      const resolved = resolveMode(request, node, manager).split('=')[1].trim()
      const evaluate = (value) =>
        runInNewContext(
          value
            .replaceAll(/inputs\.([\w-]+)/g, 'inputs["$1"]')
            .replaceAll(
              'steps.pnpm-store-mode.outputs.lookup-only',
              'steps["pnpm-store-mode"].outputs["lookup-only"]'
            ),
          { ...context, steps: { 'pnpm-store-mode': { outputs: { 'lookup-only': resolved } } } }
        )
      const nodeSetup = action.runs.steps.find((step) => step.id === 'default-node')
      expect(evaluate(nodeSetup.with.cache.slice(3, -2))).toBe(cache)
      expect(evaluate(action.runs.steps.find((step) => step.id === 'pnpm-store-lookup').if)).toBe(
        lookup
      )
    }
  )

  it.each(
    ['Linux', 'Windows', 'macOS'].flatMap((os) => ['X64', 'ARM64'].map((arch) => [os, arch]))
  )('qualifies the measured %s/%s hosted root context', (os, arch) => {
    expect(eligible({ runner: { os, arch } })).toBe(true)
  })

  it.each([
    ['PR', { github: { event_name: 'pull_request' } }],
    ['opted-out store', { inputs: { 'cache-pnpm-store': 'false' } }],
    ['opted-out lookup', { inputs: { 'cache-pnpm-store-lookup-only': 'false' } }],
    ['unknown request', { inputs: { 'cache-pnpm-store-lookup-only': 'other' } }],
    [
      'mixed lockfiles',
      { inputs: { 'cache-dependency-path': 'pnpm-lock.yaml\nmobile/pnpm-lock.yaml' } }
    ],
    ['custom lockfile', { inputs: { 'cache-dependency-path': 'cloud/pnpm-lock.yaml' } }],
    ['Node 25', { inputs: { 'node-version': '25' } }],
    ['job container', { job: { container: { id: 'container-id' } } }],
    ['self-hosted runner', { runner: { environment: 'self-hosted' } }],
    ['unknown host kind', { runner: { environment: '' } }],
    ['unmeasured architecture', { runner: { arch: 'X86' } }],
    ['unmeasured OS', { runner: { os: 'other' } }]
  ])('retains the legacy policy for %s', (_name, changes) => {
    expect(eligible(changes)).toBe(false)
  })

  it('allows an explicit request to preserve the existing force-lookup contract', () => {
    expect(
      eligible({
        inputs: {
          'cache-pnpm-store-lookup-only': 'true',
          'node-version': '25',
          'cache-dependency-path': 'custom-lock.yaml'
        },
        runner: { environment: 'self-hosted' },
        job: { container: { id: 'container-id' } }
      })
    ).toBe(true)
    expect(
      eligible({
        github: { event_name: 'pull_request' },
        inputs: { 'cache-pnpm-store-lookup-only': 'true' }
      })
    ).toBe(false)
  })

  it.each([
    ['24', 'pnpm@12.8.1', 'true'],
    ['24', 'pnpm@12.8.1+sha512.fixture', 'true'],
    ['25', 'pnpm@12.8.1', 'false'],
    ['24.x', 'pnpm@12.8.1', 'false'],
    ['24', 'pnpm@12.8.2', 'false'],
    ['24', 'pnpm@12.8.10', 'false'],
    ['24', undefined, 'false'],
    [undefined, 'pnpm@12.8.1', 'false'],
    ['24', 12, 'false']
  ])('checks manifest Node %s and manager %s before choosing lookup', (node, manager, expected) => {
    expect(resolveMode('auto', node, manager)).toBe(`lookup-only=${expected}\n`)
  })

  it('checks uppercase auto requests consistently with GitHub expression comparisons', () => {
    expect(resolveMode('AUTO', '25', 'pnpm@12.8.1')).toBe('lookup-only=false\n')
  })

  it('does not constrain an explicit request to the automatic manifest profile', () => {
    expect(resolveMode('true', '25', 'pnpm@13.0.0')).toBe('lookup-only=true\n')
  })
})
