import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import { runProcess } from '@orca/process-host'
import {
  NODE_RUNTIME_DARWIN_MINIMUM_OS,
  NODE_RUNTIME_PIN
} from '../../src/shared/node-runtime-pin.ts'
import { fetchPinnedFile, pinnedNodeCacheDir } from './pinned-node-downloads.mjs'
import { sha256File } from './update-node-runtime-pin.mjs'
import { getTarProgram } from './zip-extractor-command.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'

const root = resolve(import.meta.dirname, '../..')
const patchPath = join(root, 'config/node-runtime-patches/darwin-worker-wait.patch')
const recipe = JSON.parse(
  readFileSync(join(root, 'config/node-runtime-patches/darwin-worker-wait.json'), 'utf8')
)
const require = createRequire(import.meta.url)
const { lipoArchsToNodeArchs, parseBuildVersionMinos } = require('./macos-terminal-host-bundle.cjs')
const builds = new Map()

export function darwinTerminalNodeInputs(arch, version = NODE_RUNTIME_PIN.version) {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported macOS terminal Node architecture: ${arch}`)
  }
  if (version !== recipe.version) {
    throw new Error(`Review the Darwin worker-wait patch before moving Node to ${version}`)
  }
  return {
    ...recipe,
    arch,
    ...(arch !== process.arch
      ? {
          crossBuildMode: arch === 'x64' ? 'target-tools-under-rosetta' : 'separate-host-tools'
        }
      : {}),
    patchSha256: createHash('sha256').update(readFileSync(patchPath)).digest('hex'),
    buildScriptsSha256: Object.fromEntries(
      [
        'build-darwin-terminal-node.mjs',
        'pinned-node-downloads.mjs',
        'update-node-runtime-pin.mjs',
        'macos-terminal-host-bundle.cjs'
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(import.meta.dirname, file)))
          .digest('hex')
      ])
    ),
    minimumOs: NODE_RUNTIME_DARWIN_MINIMUM_OS
  }
}

export async function readBuiltDarwinTerminalNode(directory, inputs) {
  try {
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'))
    if (JSON.stringify(receipt.inputs) !== JSON.stringify(inputs)) {
      return null
    }
    const executable = join(directory, 'node')
    return (await sha256File(executable)) === receipt.executableSha256 ? executable : null
  } catch {
    return null
  }
}

async function runBuildCommand(program, args, options = {}) {
  const result = await runProcess(
    {
      program,
      args,
      timeoutMs: 180 * 60_000,
      maxOutputBytes: 1024 * 1024,
      ...options
    },
    'tail'
  )
  if (result.code !== 0) {
    throw new Error(`${program} failed (${result.code}):\n${result.stderr}\n${result.stdout}`)
  }
  return result.stdout
}

async function compileDarwinTerminalNode(directory, inputs, cacheDir, scratch) {
  const archivePath = join(cacheDir, inputs.sourceArchive)
  const releaseArchive = await lock(archivePath, {
    realpath: false,
    stale: 60_000,
    retries: { retries: 2160, minTimeout: 5_000, maxTimeout: 5_000 }
  })
  let archive
  try {
    archive = await fetchPinnedFile({
      url: `https://nodejs.org/dist/v${inputs.version}/${inputs.sourceArchive}`,
      destination: archivePath,
      sha256: inputs.sourceSha256
    })
  } finally {
    await releaseArchive()
  }
  const source = join(scratch, `node-v${inputs.version}`)
  await runBuildCommand(getTarProgram(), [
    '-xzf',
    archive,
    '-C',
    scratch,
    `node-v${inputs.version}`
  ])
  await runBuildCommand('patch', ['--batch', '--forward', '--fuzz=0', '-p1', '-i', patchPath], {
    cwd: source
  })
  if ((await sha256File(join(source, 'deps/uv/src/threadpool.c'))) !== inputs.workerSourceSha256) {
    throw new Error('The Node worker source does not match the reviewed patch')
  }
  const env = {
    ...process.env,
    ORCA_BACKGROUND_LAUNCH: '1',
    MACOSX_DEPLOYMENT_TARGET: inputs.minimumOs
  }
  const args = ['--without-npm', '--without-corepack', `--dest-cpu=${inputs.arch}`]
  if (process.arch !== inputs.arch) {
    const compilerArch = inputs.arch === 'x64' ? 'x86_64' : 'arm64'
    env.CC = `clang -arch ${compilerArch}`
    env.CXX = `clang++ -arch ${compilerArch}`
    if (inputs.arch === 'x64') {
      await runBuildCommand('/usr/bin/arch', ['-x86_64', '/usr/bin/true'])
      env.CC_host = env.CC
      env.CXX_host = env.CXX
      args.push('--no-cross-compiling')
    } else {
      env.CC_host = 'clang -arch x86_64'
      env.CXX_host = 'clang++ -arch x86_64'
      args.push('--cross-compiling')
    }
  }
  await runBuildCommand(join(source, 'configure'), args, { cwd: source, env })
  console.log(`[terminal-node] Building patched Node ${inputs.version} (${inputs.arch})`)
  await runBuildCommand('make', ['-j4', 'node'], { cwd: source, env })
  const executable = join(source, 'out/Release/node')
  const architectures = lipoArchsToNodeArchs(await runBuildCommand('lipo', ['-archs', executable]))
  const minimumOs = parseBuildVersionMinos(await runBuildCommand('otool', ['-l', executable]))
  if (
    architectures.length !== 1 ||
    architectures[0] !== inputs.arch ||
    minimumOs !== inputs.minimumOs
  ) {
    throw new Error('Patched terminal Node has the wrong architecture or macOS floor')
  }
  const staged = join(directory, `node.${process.pid}.partial`)
  copyFileSync(executable, staged)
  chmodSync(staged, 0o755)
  const executableSha256 = await sha256File(staged)
  renameSync(staged, join(directory, 'node'))
  const receipt = join(directory, `receipt.${process.pid}.partial`)
  writeFileSync(receipt, `${JSON.stringify({ inputs, executableSha256 }, null, 2)}\n`)
  renameSync(receipt, join(directory, 'receipt.json'))
  return join(directory, 'node')
}

export function ensureDarwinTerminalNode({ arch, cacheDir = pinnedNodeCacheDir() }) {
  if (process.platform !== 'darwin') {
    throw new Error('Build the patched macOS terminal runtime on a macOS host')
  }
  const inputs = darwinTerminalNodeInputs(arch)
  const key = createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
  const directory = join(cacheDir, 'darwin-terminal-node', key)
  const pending = builds.get(directory)
  if (pending) {
    return pending
  }
  const build = (async () => {
    mkdirSync(directory, { recursive: true })
    const cached = await readBuiltDarwinTerminalNode(directory, inputs)
    if (cached) {
      return cached
    }
    const release = await lock(directory, {
      realpath: false,
      stale: 60_000,
      retries: { retries: 2160, minTimeout: 5_000, maxTimeout: 5_000 }
    })
    let scratch
    try {
      const cached = await readBuiltDarwinTerminalNode(directory, inputs)
      if (cached) {
        return cached
      }
      scratch = mkdtempSync(join(tmpdir(), 'orca-darwin-terminal-node-build-'))
      return await compileDarwinTerminalNode(directory, inputs, cacheDir, scratch)
    } finally {
      try {
        // Release before synchronous cleanup can starve the lease heartbeat.
        await release()
      } finally {
        if (scratch) {
          rmSync(scratch, { recursive: true, force: true })
        }
      }
    }
  })()
  builds.set(directory, build)
  void build.finally(() => builds.delete(directory)).catch(() => {})
  return build
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  console.log(await ensureDarwinTerminalNode({ arch: process.argv[2] ?? process.arch }))
}
