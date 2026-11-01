import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'

const installerPath = '.github/actions/install-node-dependencies/action.yml'
const nativePath = '.github/actions/prepare-native-runtime/action.yml'
const installer = parse(readFileSync(installerPath, 'utf8'))
const native = parse(readFileSync(nativePath, 'utf8'))
const e2e = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const identity = native.runs.steps.find((step) => step.id === 'native-cache-scope')
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
  sourceDigest = 'a'.repeat(64),
  lockDigest = 'c'.repeat(64)
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-native-identity-'))
  try {
    const output = join(directory, 'output')
    const osRelease = join(directory, 'os-release')
    if (libc) {
      writeFileSync(osRelease, `ID=${libc.id}\nVERSION_ID=${libc.version}\n`)
    }
    // Isolate the container file lookup while running the production identity commands.
    const script = `pnpm() { printf "%s\\n" "$TEST_PNPM_VERSION"; }\nnode() { printf "%s\\n" "$TEST_LOCK_DIGEST"; }\n${identity.run.replaceAll('/etc/os-release', '"$TEST_OS_RELEASE"')}`
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
        TEST_LOCK_DIGEST: lockDigest,
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
  it.skipIf(process.platform === 'win32')(
    'separates runtime, Node/pnpm versions, architecture, image and libc hosts',
    () => {
      const baseline = resolveIdentity()
      expect(baseline.path.split('\n')).toEqual(paths)
      const variants = [
        { sourceDigest: 'b'.repeat(64) },
        { lockDigest: 'd'.repeat(64) },
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
