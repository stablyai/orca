import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'
import { runProcessSync } from '@orca/process-host'

const installerPath = '.github/actions/install-node-dependencies/action.yml'
const nativePath = '.github/actions/prepare-native-runtime/action.yml'
const installer = parse(readFileSync(installerPath, 'utf8'))
const native = parse(readFileSync(nativePath, 'utf8'))
const e2e = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const identity = native.runs.steps.find((step) => step.id === 'native-cache-scope')
const inputs = [...identity.env.NATIVE_SOURCE_HASH.matchAll(/'([^']+)'/g)].map((match) => match[1])
const paths = [
  'node_modules/.pnpm/node-pty@*/node_modules/node-pty/build',
  'native/windows-registry/build',
  'native/windows-security/build',
  'node_modules/.pnpm/@vscode+windows-process-tre*/node_modules/@vscode/windows-process-tree/build'
]

function resolveIdentity({
  runtime = 'node',
  node = 'v24.21.0',
  pnpm = '12.0.0',
  os = 'Windows',
  arch = 'X64',
  image = 'win22',
  libc = null,
  sourceDigest = 'a'.repeat(64)
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
        NATIVE_SOURCE_HASH: sourceDigest,
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
  it('routes every configured native cache input to native preparation', () => {
    expect(inputs.length).toBeGreaterThan(0)
    for (const file of inputs) {
      expect(classifyPrJobs([file]).native_cache_changed, file).toBe(true)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'separates runtime, Node/pnpm versions, architecture, image and libc hosts',
    () => {
      const baseline = resolveIdentity()
      expect(baseline.path.split('\n')).toEqual(paths)
      const variants = [
        { sourceDigest: 'b'.repeat(64) },
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

  it('prepares both native ABIs in the E2E build before releasing its consumers', () => {
    expect(e2e.jobs['prepare-native-cache']).toBeUndefined()
    const { steps } = e2e.jobs.build
    const install = steps.find((step) => step.id === 'deps')
    const save = steps.find((step) => step.name === 'Save compiled Node native modules')
    const build = steps.find((step) => step.name === 'Build E2E outputs')
    const cliWait = steps.find((step) => step.wait === 'e2e-cli')
    const electron = steps.find((step) => step.id === 'electron-native-runtime')
    const upload = steps.find((step) => step.name === 'Upload E2E build output')
    expect(install.with).toMatchObject({
      'native-runtime': 'node',
      'persist-native-cache': 'false',
      'cache-electron-package': 'true'
    })
    expect(save.if).toContain("steps.deps.outputs.native-cache-key != ''")
    expect(save.if).toContain("steps.deps.outputs.native-cache-hit != 'true'")
    expect(save.with).toEqual({
      key: '${{ steps.deps.outputs.native-cache-key }}',
      path: '${{ steps.deps.outputs.native-cache-path }}'
    })
    const ordered = [install, save, build, cliWait, upload, electron]
    expect(ordered.map((step) => steps.indexOf(step))).toEqual(
      ordered.map((step) => steps.indexOf(step)).sort((left, right) => left - right)
    )
    expect(upload.background).toBeUndefined()
    expect(upload.if).toBeUndefined()
    expect(electron.background).toBeUndefined()
    expect(electron.uses).toBe('./.github/actions/prepare-native-runtime')
    expect(electron.with).toEqual({
      'native-runtime': 'electron',
      'node-version': '${{ steps.deps.outputs.node-version }}'
    })
    for (const name of ['e2e', 'changed-e2e', 'orcad-serve-mode-switch', 'orcad-ssh-docker']) {
      expect(e2e.jobs[name].needs, name).toEqual(['build'])
      expect(
        e2e.jobs[name].steps.find(
          (step) => step.uses === './.github/actions/install-node-dependencies'
        ).with['native-runtime'],
        name
      ).toBe('electron')
    }
  })

  it.skipIf(process.platform === 'win32').each([false, true])(
    'detects shared native action availability=%s for older dispatch refs',
    (available) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-e2e-native-action-'))
      try {
        const output = join(directory, 'output')
        if (available) {
          mkdirSync(join(directory, '.github/actions/prepare-native-runtime'), { recursive: true })
          writeFileSync(join(directory, nativePath), '')
        }
        const step = e2e.jobs.build.steps.find(
          (candidate) => candidate.id === 'native-runtime-action'
        )
        const execution = runProcessSync({
          program: 'bash',
          args: ['-e', '-o', 'pipefail', '-c', step.run],
          cwd: directory,
          env: { ...process.env, GITHUB_OUTPUT: output },
          timeoutMs: 10_000
        })
        expect(execution.code, execution.stderr).toBe(0)
        expect(readFileSync(output, 'utf8')).toBe(`available=${available}\n`)
        const fallback = e2e.jobs.build.steps.find(
          (candidate) => candidate.name === 'Prepare Electron natives for older refs'
        )
        expect(fallback.if).toBe(
          "steps.native-runtime-action.outputs.available != 'true' || steps.deps.outputs.node-version == ''"
        )
        expect(fallback.uses).toBe('./.github/actions/install-node-dependencies')
        expect(fallback.with['native-runtime']).toBe('electron')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32').each([
    ['true', 'build-essential python3', '', 0, false],
    ['false', 'build-essential python3', '', 0, true],
    ['true', 'build-essential python3 xvfb', '', 0, true],
    ['false', 'build-essential python3', 'update', 7, true],
    ['false', 'build-essential python3', 'install', 7, true]
  ])(
    'tools=%s packages=%s failure=%s retains bounded setup',
    (present, packages, failure, status, installs) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-e2e-native-tools-'))
      try {
        const log = join(directory, 'commands')
        writeFileSync(log, '')
        mkdirSync(join(directory, '.github/scripts'), { recursive: true })
        writeFileSync(
          join(directory, '.github/scripts/prepare-ubuntu-apt.sh'),
          readFileSync('.github/scripts/prepare-ubuntu-apt.sh')
        )
        const step = e2e.jobs.build.steps.find(
          (candidate) => candidate.name === 'Install native build tools'
        )
        const execution = runProcessSync({
          program: 'bash',
          args: [
            '-e',
            '-o',
            'pipefail',
            '-c',
            `
            command() { [ "$TOOLS_PRESENT" = true ]; }
            sudo() { printf 'sudo %s\\n' "$*" >> "$COMMAND_LOG"; cat >/dev/null; }
            export -f sudo
            timeout() {
              printf 'timeout %s\\n' "$*" >> "$COMMAND_LOG"
              if [ "$4" = "$FAIL_OPERATION" ]; then return 7; fi
            }
            ${step.run}`
          ],
          cwd: directory,
          env: {
            ...process.env,
            TOOLS_PRESENT: present,
            ORCA_E2E_APT_PACKAGES: packages,
            FAIL_OPERATION: failure,
            COMMAND_LOG: log
          },
          timeoutMs: 10_000
        })
        expect(execution.code, execution.stderr).toBe(status)
        const commands = readFileSync(log, 'utf8')
        expect(commands.includes('timeout 120 sudo apt-get update')).toBe(installs)
        expect(commands.includes(`timeout 300 sudo apt-get install -y ${packages}`)).toBe(
          installs && failure !== 'update'
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
