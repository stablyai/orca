import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'
import { runProcessSync } from './script-child-process.mjs'

const installerPath = '.github/actions/install-node-dependencies/action.yml'
const nativePath = '.github/actions/prepare-native-runtime/action.yml'
const installer = parse(readFileSync(installerPath, 'utf8'))
const native = parse(readFileSync(nativePath, 'utf8'))
const identity = native.runs.steps.find((step) => step.id === 'native-cache-scope')
const inputs = [...identity.env.NATIVE_SOURCE_HASH.matchAll(/'([^']+)'/g)].map((match) => match[1])
const source = new Map(
  [...inputs, installerPath].map((file) => [file, existsSync(file) ? readFileSync(file) : null])
)
const paths = [
  'node_modules/.pnpm/node-pty@*/node_modules/node-pty/build',
  'native/windows-registry/build',
  'node_modules/.pnpm/@vscode+windows-process-tre*/node_modules/@vscode/windows-process-tree/build'
]

function sourceHash(files = source) {
  const digest = createHash('sha256')
  for (const file of inputs.toSorted()) {
    const contents = files.get(file)
    if (contents !== null) {
      digest.update(createHash('sha256').update(contents).digest())
    }
  }
  return digest.digest('hex')
}

function resolveIdentity({
  runtime = 'node',
  node = 'v24.21.0',
  pnpm = '12.0.0',
  os = 'Windows',
  arch = 'X64',
  image = 'win22',
  libc = null,
  files = source
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-native-identity-'))
  try {
    const output = join(directory, 'output')
    const osRelease = join(directory, 'os-release')
    if (libc) {
      writeFileSync(osRelease, `ID=${libc.id}\nVERSION_ID=${libc.version}\n`)
    }
    // Isolate the container file lookup while running the production identity commands.
    const script = `pnpm() { printf "%s\\n" "$TEST_PNPM_VERSION"; }\n${identity.run.replaceAll('/etc/os-release', '"$TEST_OS_RELEASE"')}`
    const execution = runProcessSync({
      program: 'bash',
      args: ['-e', '-o', 'pipefail', '-c', script],
      env: {
        ...process.env,
        NATIVE_RUNTIME: runtime,
        NODE_VERSION: node,
        RUNNER_OS: os,
        RUNNER_ARCH: arch,
        ImageOS: image,
        NATIVE_SOURCE_HASH: sourceHash(files),
        TEST_PNPM_VERSION: pnpm,
        TEST_OS_RELEASE: osRelease,
        GITHUB_OUTPUT: output
      }
    })
    expect(execution.code, execution.stderr).toBe(0)
    const result = readFileSync(output, 'utf8')
    return {
      key: /^key=(.+)$/m.exec(result)?.[1],
      scope: /^scope=(.+)$/m.exec(result)?.[1],
      path: /path<<ORCA_NATIVE_BUILD_DIRECTORIES\n([\s\S]+?)\nORCA_NATIVE_BUILD_DIRECTORIES/.exec(
        result
      )?.[1]
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('CI native cache ownership', () => {
  it('hashes the complete native preparation policy and build/probe source closure', () => {
    expect(inputs).toEqual([
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.pnpmfile.cjs',
      nativePath,
      'config/scripts/ensure-native-runtime.mjs',
      'config/scripts/rebuild-native-deps.mjs',
      'config/scripts/node-pty-job-ownership.cjs',
      'config/scripts/windows-pe-machine.cjs',
      'config/scripts/windows-process-tree-gyp-rebuild.mjs',
      'config/scripts/windows-process-tree-creation-time.cjs',
      'config/scripts/install-electron-package-binary.mjs',
      'config/scripts/electron-platform-path.mjs',
      'config/scripts/zip-extractor-command.mjs',
      'src/shared/zip-extractor-command.ts',
      'config/scripts/shared-electron-dist-cache.mjs',
      'config/scripts/space-sharing-copy.mjs',
      'config/patches/node-pty@1.1.0.patch',
      'config/patches/@vscode__windows-process-tree@0.8.0.patch',
      'native/windows-registry/src/addon.cc',
      'native/windows-registry/binding.gyp',
      'native/windows-registry/package.json',
      'native/windows-registry/index.js'
    ])
    expect(inputs).not.toContain(installerPath)
    for (const file of inputs) {
      expect(classifyPrJobs([file]).native_cache_changed, file).toBe(true)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a pnpm-only installer edit on the same native key and paths',
    () => {
      const changed = new Map(source)
      changed.set(
        installerPath,
        Buffer.from(
          readFileSync(installerPath, 'utf8').replace(
            'enabled: ${{ inputs.cache-pnpm-verification }}',
            "enabled: 'false'"
          )
        )
      )
      expect(changed.get(installerPath)).not.toEqual(source.get(installerPath))
      expect(resolveIdentity({ files: changed })).toEqual(resolveIdentity())
    }
  )

  it.skipIf(process.platform === 'win32').each(inputs)(
    'changes the requested key when native input %s changes',
    (file) => {
      const changed = new Map(source)
      changed.set(
        file,
        Buffer.concat([source.get(file) ?? Buffer.alloc(0), Buffer.from('\nchanged')])
      )
      expect(resolveIdentity({ files: changed }).key).not.toBe(resolveIdentity().key)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'separates runtime, Node/pnpm versions, architecture, image and libc hosts',
    () => {
      const baseline = resolveIdentity()
      expect(baseline.path.split('\n')).toEqual(paths)
      const variants = [
        { runtime: 'electron' },
        { node: 'v24.22.0' },
        { pnpm: '12.1.0' },
        { arch: 'ARM64' },
        { image: 'win11' },
        { os: 'Linux', image: 'ubuntu22', libc: { id: 'ubuntu', version: '22.04' } },
        { os: 'Linux', image: 'ubuntu22', libc: { id: 'almalinux', version: '8.10' } }
      ].map(resolveIdentity)
      expect(new Set([baseline, ...variants].map(({ key }) => key)).size).toBe(variants.length + 1)
      expect(variants.at(-1).scope).toBe('almalinux-8.10')
      expect(variants.every(({ path }) => path === baseline.path)).toBe(true)
    }
  )

  it('keeps early input rejection before dependency installation and native restoration', () => {
    const early = installer.runs.steps.findIndex((step) => step.name === 'Validate native runtime')
    const install = installer.runs.steps.findIndex((step) => step.name === 'Install dependencies')
    const prepare = installer.runs.steps.findIndex((step) => step.id === 'native-runtime')
    expect(early).toBeLessThan(install)
    expect(install).toBeLessThan(prepare)
    expect(installer.runs.steps[early].run).toContain('none|node|electron)')
    expect(installer.runs.steps[prepare].if).toBe("inputs.native-runtime != 'none'")
  })

  it.skipIf(process.platform === 'win32')(
    'rejects invalid runtime and missing resolved Node before cache restoration',
    () => {
      const early = installer.runs.steps.find((step) => step.name === 'Validate native runtime')
      const validate = native.runs.steps.find((step) => step.name === 'Validate native runtime')
      for (const run of [early.run, validate.run]) {
        expect(
          runProcessSync({
            program: 'bash',
            args: ['-e', '-c', run],
            env: { ...process.env, NATIVE_RUNTIME: 'unsupported', NODE_VERSION: 'v24.21.0' },
            stdio: 'pipe'
          }).code
        ).not.toBe(0)
      }
      expect(
        runProcessSync({
          program: 'bash',
          args: ['-e', '-c', validate.run],
          env: { ...process.env, NATIVE_RUNTIME: 'node', NODE_VERSION: '' },
          stdio: 'pipe'
        }).code
      ).not.toBe(0)
    }
  )

  it('uses requested identity on both restores and saves the Node ABI before Windows switches to Electron', () => {
    for (const step of native.runs.steps.filter((step) => step.uses?.startsWith('actions/cache'))) {
      expect(step.with.key).toBe('${{ steps.native-cache-scope.outputs.key }}')
      expect(step.with.path.trim().split('\n')).toEqual(paths)
      expect(step.with['restore-keys']).toBeUndefined()
    }
    const job = parse(readFileSync('.github/workflows/pr.yml', 'utf8')).jobs.package_windows
    const save = job.steps.find((step) => step.name === 'Save compiled Node native modules')
    const install = job.steps.find((step) => step.id === 'deps')
    const build = job.steps.find((step) => step.name === 'Build package inputs')
    const electron = job.steps.find((step) => step.name === 'Prepare Electron native runtime')
    expect(install.with['persist-native-cache']).toBe('false')
    expect(save.with).toEqual({
      key: '${{ steps.deps.outputs.native-cache-key }}',
      path: '${{ steps.deps.outputs.native-cache-path }}'
    })
    expect(job.steps.indexOf(save)).toBeLessThan(job.steps.indexOf(build))
    expect(job.steps.indexOf(build)).toBeLessThan(job.steps.indexOf(electron))
    expect(electron.uses).toBe('./.github/actions/prepare-native-runtime')
    expect(electron.with).toEqual({
      'native-runtime': 'electron',
      'node-version': '${{ steps.deps.outputs.node-version }}'
    })
    expect(native.outputs['cache-key'].value).toBe('${{ steps.native-cache-scope.outputs.key }}')
  })

  it.skipIf(process.platform === 'win32')(
    'keeps cache post-job paths when the nested step output context is absent',
    () => {
      const postContext = { steps: {} }
      const evaluateInput = (value) =>
        value.replace(
          /\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}/g,
          (_expression, step, output) => postContext.steps[step]?.outputs?.[output] ?? ''
        )
      expect(evaluateInput('${{ steps.native-cache-scope.outputs.path }}')).toBe('')
      const emitted = resolveIdentity().path
      for (const step of native.runs.steps.filter((step) =>
        step.uses?.startsWith('actions/cache')
      )) {
        expect(evaluateInput(step.with.path).trim()).toBe(emitted)
      }
    }
  )
})
