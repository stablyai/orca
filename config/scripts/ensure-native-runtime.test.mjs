import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  runProcessSync
} from '../../src/shared/child-process/run-process.ts'
import { resolveCliCommand } from '../../src/shared/node-cli-command-resolution.ts'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'
import {
  nodeGypRebuildInvocation,
  nodeGypRebuildTimeoutMs
} from './windows-process-tree-gyp-rebuild.mjs'

const sourceScriptPath = fileURLToPath(new URL('./ensure-native-runtime.mjs', import.meta.url))
// The import walk sees `from './x.mjs'` only, so the createRequire'd CJS
// siblings have to be named. Without them the temp project cannot even load.
const REQUIRED_CJS_SIBLINGS = [
  'node-pty-job-ownership.cjs',
  'windows-process-tree-creation-time.cjs'
]

describe('ensure-native-runtime', () => {
  it('rechecks Node native modules in fresh child processes after rebuilding', () => {
    const projectDir = mkTempProject()

    try {
      const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
      const logPath = join(projectDir, 'native-runtime.log')
      const markerPath = join(projectDir, 'rebuilt.marker')
      writeFakeNativeModules(projectDir)
      writeNodePtyPatchFile(projectDir)
      writeFakeNodeGyp(projectDir)
      const verboseOutputBytes = DEFAULT_MAX_OUTPUT_BYTES + 1024 * 1024

      const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
        cwd: projectDir,
        encoding: 'utf8',
        maxBuffer: DEFAULT_MAX_OUTPUT_BYTES * 4,
        env: envForNativeFixture(projectDir, {
          ORCA_NATIVE_TEST_LOG: logPath,
          ORCA_NATIVE_TEST_MARKER: markerPath,
          ORCA_NATIVE_TEST_VERBOSE_OUTPUT_BYTES: String(verboseOutputBytes)
        })
      })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.indexOf('node-gyp stdout complete\n')).toBe(verboseOutputBytes)
      expect(/^x+$/.test(result.stdout.slice(0, verboseOutputBytes))).toBe(true)
      expect(result.stderr).toContain('node-gyp stderr complete\n')
      const log = readFileSync(logPath, 'utf8')
      expect(log).toContain(`node-gyp rebuild --arch=${process.arch}\n`)
      expect(log).toContain(`node-gyp timeout=${nodeGypRebuildTimeoutMs('node-pty')}\n`)
      expect(log).toContain(`trackFileAccess=${process.platform === 'win32' ? 'false' : ''}\n`)
      expect(log).toContain(join('node_modules', 'node-pty'))
      if (process.platform === 'linux') {
        expect(log).toMatch(/^cxxflags=(?:.*\s)?-std=gnu\+\+2a$/m)
      }
      expect(log.split('\n').filter((line) => line.startsWith('node-pty child '))).toEqual([
        expect.stringMatching(/^node-pty child (?:conpty|pty) marker=false$/),
        expect.stringMatching(/^node-pty child (?:conpty|pty) marker=true$/)
      ])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32').each([
    { trackingEnv: {}, tracking: 'false' },
    { trackingEnv: { TrackFileAccess: 'true' }, tracking: 'true' },
    { trackingEnv: { trackfileaccess: 'true' }, tracking: 'true' },
    { trackingEnv: { tRaCkFiLeAcCeSs: 'false' }, tracking: 'false' }
  ])(
    'rebuilds other failed Windows addons with patched node-pty and tracking=$tracking',
    ({ trackingEnv, tracking }) => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        writeFakeNativeModules(projectDir, { windowsRegistryRequiresMarker: true })
        writeNodePtyPatchFile(projectDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ...trackingEnv,
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        const log = readFileSync(logPath, 'utf8')
        expect(
          log.split('\n').filter((line) => line === `node-gyp rebuild --arch=${process.arch}`)
        ).toHaveLength(2)
        expect(
          log.split('\n').filter((line) => line === `trackFileAccess=${tracking}`)
        ).toHaveLength(2)
        expect(log).toContain(join('node_modules', 'node-pty'))
        expect(log).toContain(join('node_modules', '@orca', 'windows-registry'))
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds patched node-pty artifacts even when the Node load check passes',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        writeLoadableNativeModules(projectDir)
        writeNodePtyPatchFile(projectDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).toContain(
          'Patched node-pty build artifacts are missing; rebuilding native deps.'
        )
        expect(readFileSync(logPath, 'utf8')).toContain(`node-gyp rebuild --arch=${process.arch}\n`)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds when patched artifacts exist but node-pty resolves to prebuilds',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        writeLoadableNativeModules(projectDir)
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).toContain("expected build/Release so Orca's node-pty patch is active")
        expect(readFileSync(logPath, 'utf8')).toContain(`node-gyp rebuild --arch=${process.arch}\n`)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the fast path when the platform-specific patched artifacts exist',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        writeLoadableNativeModules(projectDir, { nativeDir: '../build/Release/' })
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).not.toContain('Patched node-pty build artifacts are missing')
        expect(readFileSync(logPath, 'utf8')).not.toContain('node-gyp rebuild')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )
  it('finds the installed node-gyp entry from an addon without build tools on PATH', () => {
    const { command, prefixArgs } = resolvePnpmCliInvocation()
    const program = isAbsolute(command) ? command : resolveCliCommand(parse(command).name)
    expect(isAbsolute(program), 'pnpm must be installed for the native rebuild contract').toBe(true)
    const projectDir = mkTempProject()
    try {
      writeFakeNativeModules(projectDir)
      const addonDir = join(projectDir, 'node_modules', 'node-pty')
      const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'path') {
          env[key] = ''
        }
      }
      const oldInvocation = runProcessSync({
        program,
        args: [
          ...prefixArgs,
          '--config.verify-deps-before-run=false',
          'exec',
          'node-gyp',
          '--version'
        ],
        cwd: addonDir,
        env,
        timeoutMs: 20_000
      })
      expect(oldInvocation.code).not.toBe(0)
      expect(`${oldInvocation.stdout}\n${oldInvocation.stderr}`).toContain(
        'Command "node-gyp" not found'
      )
      const { args, cwd } = nodeGypRebuildInvocation(process.arch, addonDir)
      const installedInvocation = runProcessSync({
        program: process.execPath,
        args: [args[0], '--version'],
        cwd,
        env,
        timeoutMs: 20_000
      })
      expect(
        installedInvocation.code,
        `${installedInvocation.stdout}\n${installedInvocation.stderr}`
      ).toBe(0)
      const manifest = JSON.parse(
        readFileSync(new URL('../../node_modules/node-gyp/package.json', import.meta.url), 'utf8')
      )
      expect(installedInvocation.stdout.trim()).toBe(`v${manifest.version}`)
      expect(existsSync(join(addonDir, 'pnpm-lock.yaml'))).toBe(false)
    } finally {
      removeTreeSync(projectDir)
    }
  })
})

function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-native-runtime-'))
  // Walked, not listed: the script imports windows-process-tree-gyp-rebuild.mjs, and a fixture
  // missing it fails every case with a module-resolution error instead of the defect under test.
  copyScriptWithLocalModules(sourceScriptPath, join(projectDir, 'config', 'scripts'))
  writeFileSync(
    join(projectDir, 'config', 'scripts', 'script-child-process.mjs'),
    `import { appendFileSync } from 'node:fs'
import { describeProcessFailure, runProcessSync as run } from ${JSON.stringify(new URL('./script-child-process.mjs', import.meta.url).href)}
export { describeProcessFailure }
export function runProcessSync(options) {
  appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-gyp timeout=\${options.timeoutMs}\\n\`)
  return run(options)
}
`
  )
  for (const name of REQUIRED_CJS_SIBLINGS) {
    copyFileSync(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      join(projectDir, 'config', 'scripts', name)
    )
  }
  return projectDir
}

function envForNativeFixture(projectDir, extraEnv) {
  // An inherited tracking preference would mask the Windows default under test.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'trackfileaccess')
  )
  return {
    ...inherited,
    ...extraEnv,
    npm_config_node_gyp: join(projectDir, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  }
}

function writeFakeNativeModules(projectDir, { windowsRegistryRequiresMarker = false } = {}) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(
    join(nodePtyDir, 'package.json'),
    '{"name":"node-pty","version":"1.1.0","main":"index.js"}\n'
  )
  mkdirSync(join(nodePtyDir, 'scripts'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'scripts', 'post-install.js'), '')

  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  const markerExists = existsSync(process.env.ORCA_NATIVE_TEST_MARKER)
  appendFileSync(
    process.env.ORCA_NATIVE_TEST_LOG,
    \`node-pty \${process.argv.includes('--check-only') ? 'child' : 'parent'} \${nativeName} marker=\${markerExists}\\n\`
  )
  if (!markerExists) {
    throw new Error('ABI mismatch sentinel')
  }
  return {
    dir: '../build/Release/',
    module: {
      listJobProcessIds() {},
      terminateJob() {},
      assignCurrentProcessToJob() {}
    }
  }
}
`
  )
  writeFakeWindowsRegistry(projectDir, { requiresMarker: windowsRegistryRequiresMarker })
  if (process.platform === 'win32') {
    const buildDir = join(nodePtyDir, 'build', 'Release')
    writePatchedNodePtyBuildArtifacts(projectDir)
    writeFileSync(join(buildDir, 'conpty.node'), Buffer.from('msys-2.0.dll', 'utf16le'))
  }
}

function writeLoadableNativeModules(projectDir, { nativeDir = null } = {}) {
  const nodePtyDir = join(projectDir, 'node_modules', 'node-pty')
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  writeFileSync(
    join(nodePtyDir, 'package.json'),
    '{"name":"node-pty","version":"1.1.0","main":"index.js"}\n'
  )
  mkdirSync(join(nodePtyDir, 'scripts'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'scripts', 'post-install.js'), '')

  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync, existsSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  const rebuilt = existsSync(process.env.ORCA_NATIVE_TEST_MARKER)
  const dir = ${JSON.stringify(nativeDir)} ??
    (rebuilt ? '../build/Release/' : '../prebuilds/' + process.platform + '-' + process.arch + '/')
  appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-pty load \${nativeName} dir=\${dir}\\n\`)
  return {
    dir,
    module: {
      listJobProcessIds: () => [],
      terminateJob: () => true,
      assignCurrentProcessToJob: () => true
    }
  }
}
`
  )
  writeFakeWindowsRegistry(projectDir)
}

function writeFakeWindowsRegistry(projectDir, { requiresMarker = false } = {}) {
  if (process.platform !== 'win32') {
    return
  }
  const registryDir = join(projectDir, 'node_modules', '@orca', 'windows-registry')
  mkdirSync(registryDir, { recursive: true })
  writeFileSync(
    join(registryDir, 'package.json'),
    '{"name":"@orca/windows-registry","version":"1.0.0","main":"index.js"}\n'
  )
  const markerGate = requiresMarker
    ? `if (!require('node:fs').existsSync(process.env.ORCA_NATIVE_TEST_MARKER)) { throw new Error('registry ABI mismatch sentinel') }`
    : ''
  writeFileSync(
    join(registryDir, 'index.js'),
    `exports.HK = { CU: 0x80000001 }; exports.getRegistryKey = () => { ${markerGate}; return {} }\n`
  )
  const processTreeDir = join(projectDir, 'node_modules', '@vscode', 'windows-process-tree')
  mkdirSync(processTreeDir, { recursive: true })
  writeFileSync(
    join(processTreeDir, 'index.js'),
    'exports.supportedProcessDataFlags = 4; exports.getProcessCreationTime = () => 1\n'
  )
}

function writeNodePtyPatchFile(projectDir) {
  mkdirSync(join(projectDir, 'config', 'patches'), { recursive: true })
  writeFileSync(join(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch'), 'patch marker\n')
}

function writePatchedNodePtyBuildArtifacts(projectDir) {
  const buildDir = join(projectDir, 'node_modules', 'node-pty', 'build', 'Release')
  mkdirSync(buildDir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(buildDir, 'conpty.node'), '')
    mkdirSync(join(buildDir, 'conpty'), { recursive: true })
    writeFileSync(join(buildDir, 'conpty', 'conpty.dll'), '')
    writeFileSync(join(buildDir, 'conpty', 'OpenConsole.exe'), '')
    return
  }
  writeFileSync(join(buildDir, 'pty.node'), '')
  if (process.platform === 'darwin') {
    writeFileSync(join(buildDir, 'spawn-helper'), '')
  }
}

function writeFakeNodeGyp(projectDir) {
  const toolDir = join(projectDir, 'node_modules', 'node-gyp', 'bin')
  mkdirSync(toolDir, { recursive: true })
  writeFileSync(
    join(toolDir, 'node-gyp.js'),
    `
const { appendFileSync, writeFileSync, writeSync } = require('node:fs')
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-gyp \${process.argv.slice(2).join(' ')}\\n\`)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`cwd=\${process.cwd()}\\n\`)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`cxxflags=\${process.env.CXXFLAGS || ''}\\n\`)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`trackFileAccess=\${process.env.TrackFileAccess ?? ''}\\n\`)
if (process.env.ORCA_NATIVE_TEST_VERBOSE_OUTPUT_BYTES) {
  const output = Buffer.alloc(Number(process.env.ORCA_NATIVE_TEST_VERBOSE_OUTPUT_BYTES), 'x')
  for (let offset = 0; offset < output.length;) {
    offset += writeSync(1, output.subarray(offset))
  }
  writeSync(1, 'node-gyp stdout complete\\n')
  writeSync(2, 'node-gyp stderr complete\\n')
}
writeFileSync(process.env.ORCA_NATIVE_TEST_MARKER, 'rebuilt')
`
  )
}
