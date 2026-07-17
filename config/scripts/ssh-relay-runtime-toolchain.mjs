import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, win32 } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const MAX_TOOL_BYTES = 300 * 1024 * 1024
const TOOL_TIMEOUT_MS = 60_000
const TOOL_OUTPUT_BYTES = 1024 * 1024
const MAX_PACKAGE_FILES = 500
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024

async function sha256File(path) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size > MAX_TOOL_BYTES) {
    throw new Error(`Runtime build tool is not a bounded regular file: ${path}`)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return `sha256:${hash.digest('hex')}`
}

async function capture(command, args) {
  try {
    return await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: TOOL_OUTPUT_BYTES,
      timeout: TOOL_TIMEOUT_MS,
      windowsHide: true
    })
  } catch (error) {
    if (typeof error?.stdout === 'string' || typeof error?.stderr === 'string') {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
    }
    throw error
  }
}

export function selectSshRelayRuntimeToolVersion({ stdout = '', stderr = '' }, pattern) {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const version = pattern ? lines.find((line) => pattern.test(line)) : lines[0]
  if (!version || Buffer.byteLength(version) > 512) {
    const diagnostic = lines.slice(0, 3).join(' | ').slice(0, 512) || '<empty>'
    throw new Error(`Runtime build tool did not report a bounded version line: ${diagnostic}`)
  }
  return version
}

export function sshRelayRuntimePythonCommand(platform, env = process.env) {
  return platform === 'linux' && env.NODE_GYP_FORCE_PYTHON
    ? env.NODE_GYP_FORCE_PYTHON
    : platform === 'win32'
      ? 'python.exe'
      : 'python3'
}

async function locateExecutable(command, { windowsMsvcLinker = false, xcrun = false } = {}) {
  if (isAbsolute(command)) {
    return realpath(command)
  }
  const locator = xcrun
    ? ['xcrun', ['--find', command]]
    : process.platform === 'win32'
      ? ['where.exe', [command]]
      : ['which', [command]]
  const result = await capture(...locator)
  const paths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const path = windowsMsvcLinker ? selectSshRelayRuntimeWindowsMsvcLinker(paths) : paths[0]
  if (!path || !isAbsolute(path)) {
    throw new Error(`Runtime build tool executable could not be resolved: ${command}`)
  }
  return realpath(path)
}

async function executableRecord({
  command,
  args,
  versionCommand,
  versionArgs,
  versionPattern,
  windowsMsvcToolsetVersion = false,
  xcrun = false
}) {
  const path = await locateExecutable(command, {
    windowsMsvcLinker: windowsMsvcToolsetVersion,
    xcrun
  })
  const result = windowsMsvcToolsetVersion
    ? { stdout: sshRelayRuntimeWindowsMsvcToolsetVersion(path) }
    : await capture(versionCommand ?? path, versionArgs ?? args)
  return {
    version: selectSshRelayRuntimeToolVersion(result, versionPattern),
    sha256: await sha256File(path)
  }
}

async function packageTreeRecord(name) {
  const parsed = require(`${name}/package.json`)
  const root = dirname(require.resolve(`${name}/package.json`))
  const files = []
  let totalBytes = 0
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
        totalBytes += (await stat(path)).size
      } else {
        throw new Error(`Runtime build package contains a special entry: ${name}`)
      }
      if (files.length > MAX_PACKAGE_FILES) {
        throw new Error(`Runtime build package exceeds the file-count bound: ${name}`)
      }
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error(`Runtime build package exceeds the byte bound: ${name}`)
      }
    }
  }
  await visit(root)
  const hash = createHash('sha256')
  for (const path of files) {
    hash.update(relative(root, path).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(await sha256File(path))
    hash.update('\n')
  }
  return { version: parsed.version, sha256: `sha256:${hash.digest('hex')}`, files: files.length }
}

export function sshRelayRuntimeBuilderIdentity({ gitCommit, env = process.env }) {
  if (env.GITHUB_ACTIONS !== 'true') {
    return `local://${process.platform}/${process.arch}`
  }
  if (
    !/^[0-9a-f]{40}$/.test(gitCommit) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')
  ) {
    throw new Error('GitHub runtime builder identity is incomplete')
  }
  const workflow = (env.GITHUB_WORKFLOW_REF ?? '').split('@')[0]
  const prefix = `${env.GITHUB_REPOSITORY}/`
  if (
    !workflow.startsWith(prefix) ||
    workflow.slice(prefix.length) !== '.github/workflows/ssh-relay-runtime-artifacts.yml'
  ) {
    throw new Error('GitHub runtime builder workflow identity is malformed')
  }
  return `https://github.com/${env.GITHUB_REPOSITORY}/blob/${gitCommit}/${workflow.slice(prefix.length)}`
}

export function sshRelayRuntimeRunnerIdentity({ env = process.env } = {}) {
  const github = env.GITHUB_ACTIONS === 'true'
  const identity = {
    os: env.RUNNER_OS ?? process.platform,
    architecture: env.RUNNER_ARCH ?? process.arch,
    environment: env.RUNNER_ENVIRONMENT ?? (github ? undefined : 'local'),
    requestedLabel: env.ORCA_RUNTIME_REQUESTED_RUNNER ?? (github ? undefined : 'local'),
    image: {
      os: env.ImageOS ?? (github ? undefined : process.platform),
      version: env.ImageVersion ?? (github ? undefined : 'local')
    }
  }
  if (
    !identity.os ||
    !identity.architecture ||
    !identity.environment ||
    !identity.requestedLabel ||
    !identity.image.os ||
    !identity.image.version
  ) {
    throw new Error('Runtime runner identity is incomplete')
  }
  return identity
}

export function sshRelayRuntimeStripVersionProbe(platform) {
  // Why: GNU strip is silent/versionless without --version, while Apple strip delegates its
  // version identity to the selected Xcode toolchain.
  return platform === 'darwin'
    ? { versionCommand: 'xcodebuild', versionArgs: ['-version'] }
    : { args: ['--version'] }
}

export function sshRelayRuntimeWindowsMsvcToolsetVersion(path) {
  const normalized = win32.normalize(path)
  const segments = normalized.split(win32.sep)
  const msvcIndexes = segments.flatMap((segment, index) =>
    segment.toLowerCase() === 'msvc' ? [index] : []
  )
  const msvcIndex = msvcIndexes[0]
  const version = segments[msvcIndex + 1]
  if (
    !win32.isAbsolute(normalized) ||
    msvcIndexes.length !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(version ?? '') ||
    segments[msvcIndex + 2]?.toLowerCase() !== 'bin' ||
    segments.at(-1)?.toLowerCase() !== 'link.exe'
  ) {
    const diagnostic = segments.slice(-12).join(win32.sep).slice(-512) || '<empty>'
    throw new Error(`Resolved Windows linker is not in a bounded MSVC toolset path: ${diagnostic}`)
  }
  // Why: hosted link.exe has no version resource; its resolved toolset path plus byte hash is exact.
  return `MSVC ${version}`
}

export function selectSshRelayRuntimeWindowsMsvcLinker(paths) {
  const candidates = [
    ...new Map(paths.map((path) => [win32.normalize(path).toLowerCase(), path])).values()
  ]
  const matches = candidates.filter((path) => {
    try {
      sshRelayRuntimeWindowsMsvcToolsetVersion(path)
      return true
    } catch {
      return false
    }
  })
  if (matches.length !== 1) {
    const diagnostic =
      candidates
        .slice(-4)
        .map((path) => win32.normalize(path).split(win32.sep).slice(-8).join(win32.sep))
        .join(' | ')
        .slice(-512) || '<empty>'
    throw new Error(
      `Runtime build did not resolve exactly one canonical MSVC linker: ${diagnostic}`
    )
  }
  // Why: Git for Windows also provides link.exe and is prepended for signature verification in CI.
  return matches[0]
}

export function assertSshRelayRuntimeToolchain(toolchain, tuple) {
  const common = ['buildNode', 'bundledNode', 'compiler', 'buildSystem', 'python', 'archive']
  const expected = tuple.startsWith('win32-')
    ? [...common, 'linker', 'nodeAddonApi', 'nodeGyp']
    : [...common, 'nodeAddonApi', 'nodeGyp', 'strip']
  if (!isDeepStrictEqual(Object.keys(toolchain).sort(), expected.sort())) {
    throw new Error(`Runtime toolchain record is incomplete for ${tuple}`)
  }
  for (const [name, record] of Object.entries(toolchain)) {
    const keys = Object.keys(record).sort()
    const expectedKeys =
      record.files === undefined ? ['sha256', 'version'] : ['files', 'sha256', 'version']
    if (
      !isDeepStrictEqual(keys, expectedKeys) ||
      typeof record.version !== 'string' ||
      record.version.length === 0 ||
      Buffer.byteLength(record.version) > 512 ||
      record.version.includes('\n') ||
      !/^sha256:[0-9a-f]{64}$/.test(record.sha256) ||
      (record.files !== undefined && (!Number.isSafeInteger(record.files) || record.files <= 0))
    ) {
      throw new Error(`Runtime toolchain record is malformed: ${name}`)
    }
  }
}

export async function collectSshRelayRuntimeToolchain(nodePath) {
  const common = {
    bundledNode: await executableRecord({ command: nodePath, args: ['--version'] }),
    buildNode: await executableRecord({ command: process.execPath, args: ['--version'] }),
    nodeGyp: await packageTreeRecord('node-gyp'),
    nodeAddonApi: await packageTreeRecord('node-addon-api')
  }
  if (process.platform === 'win32') {
    const toolchain = {
      ...common,
      compiler: await executableRecord({
        command: 'cl.exe',
        args: [],
        versionPattern: /Compiler Version/i
      }),
      linker: await executableRecord({
        command: 'link.exe',
        args: [],
        windowsMsvcToolsetVersion: true,
        versionPattern: /^MSVC \d+\.\d+\.\d+$/
      }),
      buildSystem: await executableRecord({
        command: 'msbuild.exe',
        args: ['-version', '-nologo']
      }),
      python: await executableRecord({ command: 'python.exe', args: ['--version'] }),
      archive: await packageTreeRecord('yazl')
    }
    assertSshRelayRuntimeToolchain(toolchain, 'win32-x64')
    return toolchain
  }
  const toolchain = {
    ...common,
    compiler: await executableRecord({
      command: process.platform === 'darwin' ? 'clang++' : 'c++',
      args: ['--version'],
      xcrun: process.platform === 'darwin'
    }),
    buildSystem: await executableRecord({ command: 'make', args: ['--version'] }),
    python: await executableRecord({
      command: sshRelayRuntimePythonCommand(process.platform),
      args: ['--version']
    }),
    archive: await executableRecord({ command: 'xz', args: ['--version'] }),
    strip: await executableRecord({
      command: 'strip',
      ...sshRelayRuntimeStripVersionProbe(process.platform),
      xcrun: process.platform === 'darwin'
    })
  }
  assertSshRelayRuntimeToolchain(toolchain, `${process.platform}-x64`)
  return toolchain
}
