import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { peImage } from './windows-pe-image-fixture.mjs'
import { canReusePreparedRelayAddon } from './relay-windows-process-tree-prepared-addon.mjs'
import { runProcessSync } from './script-child-process.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function prepared(arch = 'x64', suffix = 'spawnOutsideJob') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-prepared-relay-addon-'))
  directories.push(directory)
  const addonPath = join(directory, 'process-tree.node')
  writeFileSync(addonPath, Buffer.concat([peImage({ arch }), Buffer.from(suffix)]))
  return {
    enabled: true,
    arch,
    hostArch: arch,
    platform: 'win32',
    sourceRepaired: false,
    addonPath,
    checkRuntime: vi.fn(() => ({ code: 0, timedOut: false, outputTruncated: false }))
  }
}

describe('reusing a prepared Windows relay addon', () => {
  it.each(['x64', 'arm64'])(
    'accepts a clean launcher-capable %s addon after its runtime probe',
    (arch) => {
      const options = prepared(arch)
      expect(canReusePreparedRelayAddon(options)).toBe(true)
      expect(options.checkRuntime).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { enabled: false },
    { enabled: undefined },
    { platform: 'darwin' },
    { platform: 'linux' },
    { hostArch: 'arm64' },
    { sourceRepaired: true },
    { sourceRepaired: undefined }
  ])('compiles freshly without current same-host preparation: %j', (overrides) => {
    const options = { ...prepared(), ...overrides }
    expect(canReusePreparedRelayAddon(options)).toBe(false)
    expect(options.checkRuntime).not.toHaveBeenCalled()
  })

  it.each([
    ['upstream reader', 'ReadProcessMemory spawnOutsideJob'],
    ['pre-launcher addon', 'getProcessCreationTime']
  ])('refuses the %s before loading it', (_label, suffix) => {
    const options = prepared('x64', suffix)
    expect(canReusePreparedRelayAddon(options)).toBe(false)
    expect(options.checkRuntime).not.toHaveBeenCalled()
  })

  it('refuses missing, truncated and wrong-architecture binaries', () => {
    const options = prepared()
    for (const bytes of [Buffer.from('spawnOutsideJob'), peImage({ arch: 'arm64' })]) {
      writeFileSync(options.addonPath, bytes)
      expect(canReusePreparedRelayAddon(options)).toBe(false)
    }
    rmSync(options.addonPath)
    expect(canReusePreparedRelayAddon(options)).toBe(false)
    expect(options.checkRuntime).not.toHaveBeenCalled()
  })

  it.each([
    { code: 1, timedOut: false, outputTruncated: false },
    { code: null, timedOut: false, outputTruncated: false },
    { code: 0, timedOut: true, outputTruncated: false },
    { code: 0, timedOut: false, outputTruncated: true }
  ])('falls back when native loading or CreationTime validation fails: %j', (result) => {
    const options = prepared()
    options.checkRuntime.mockReturnValue(result)
    expect(canReusePreparedRelayAddon(options)).toBe(false)
  })

  it('falls back on probe exceptions', () => {
    const options = prepared()
    options.checkRuntime.mockImplementation(() => {
      throw new Error('probe spawn failed')
    })
    expect(canReusePreparedRelayAddon(options)).toBe(false)
  })
})

const workflow = parse(readFileSync('.github/workflows/ssh-windows-hosts.yml', 'utf8'))
const steps = workflow.jobs.hosts.steps
const preparation = steps.find((step) => step.id === 'dependencies')
const build = steps.find((step) => step.name === "Build this runner's Windows process-table addon")

it.each(['pull_request', 'workflow_dispatch'])(
  'requests reuse only after an exact prepared PR hit under %s',
  (event) => {
    expect(workflow.on.pull_request.paths).toContain(
      'config/scripts/relay-windows-process-tree-prepared-addon*.mjs'
    )
    expect(preparation.with['native-runtime']).toBe('node')
    expect(steps.indexOf(preparation)).toBeLessThan(steps.indexOf(build))
    for (const cacheHit of ['true', 'false', '', undefined]) {
      const expression = build.env.REUSE_PREPARED_RUNTIME.slice(3, -2).replace(
        'outputs.native-cache-hit',
        'outputs["native-cache-hit"]'
      )
      const enabled = runInNewContext(expression, {
        github: { event_name: event },
        steps: { dependencies: { outputs: { 'native-cache-hit': cacheHit } } }
      })
      expect(enabled).toBe(event === 'pull_request' && cacheHit === 'true')
    }
  }
)

it.each(['x64', 'arm64'])('passes the optional reuse flag safely to the %s builder', (arch) => {
  for (const enabled of ['true', 'false']) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-relay-build-args-'))
    directories.push(directory)
    const output = join(directory, 'arguments.txt')
    const script = `node() { printf '%s\n' "$@" > "$ARGUMENTS_FILE"; }\n${build.run.replaceAll('${{ matrix.arch }}', arch)}`
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-c', script],
      cwd: directory,
      env: { ...process.env, ARGUMENTS_FILE: output, REUSE_PREPARED_RUNTIME: enabled },
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(output, 'utf8').trim().split('\n')).toEqual([
      'config/scripts/build-windows-process-tree-relay-addon.mjs',
      `--arch=${arch}`,
      ...(enabled === 'true' ? ['--reuse-prepared-runtime'] : [])
    ])
  }
})
