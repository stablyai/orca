import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess, runProcessSync } from '@orca/process-host'
import { ensureDarwinTerminalNode } from './build-darwin-terminal-node.mjs'
import { preparePinnedNodeDir } from './pinned-node-downloads.mjs'
import { nodeGypRebuild, stageNodeAddonApi } from './orcad-prebuild-node-gyp.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'
import { NODE_RUNTIME_PIN } from '../../src/shared/node-runtime-pin.ts'

export function readDarwinVerificationArch(args, defaultArch = process.arch) {
  if (args.length > 1 || (args.length === 1 && !/^--arch=(arm64|x64)$/.test(args[0]))) {
    throw new Error('Usage: verify-darwin-terminal-node.mjs [--arch=arm64|x64]')
  }
  const arch = args.length ? args[0].slice('--arch='.length) : defaultArch
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported macOS terminal Node architecture: ${arch}`)
  }
  return arch
}

async function verifyDarwinTerminalNode(arch) {
  if (process.platform !== 'darwin') {
    throw new Error('Verify the Darwin terminal runtime on a macOS host')
  }
  const executable = await ensureDarwinTerminalNode({ arch })
  const scratch = mkdtempSync(join(tmpdir(), 'orca-darwin-terminal-node-proof-'))
  const require = createRequire(import.meta.url)
  try {
    const headers = await preparePinnedNodeDir({
      target: `darwin-${arch}`,
      workDir: join(scratch, 'headers')
    })
    const sourcePty = dirname(require.resolve('node-pty/package.json'))
    const stagedPty = join(scratch, 'node-pty')
    for (const entry of ['package.json', 'binding.gyp', 'src', 'lib']) {
      cpSync(join(sourcePty, entry), join(stagedPty, entry), { recursive: true })
    }
    stageNodeAddonApi(sourcePty, stagedPty)
    await nodeGypRebuild({
      stagedDir: stagedPty,
      workDir: scratch,
      nodeDir: headers,
      runProcess: (options) =>
        runProcessSync({
          ...options,
          program: executable,
          timeoutMs: 120_000,
          env: { ...options.env, ORCA_BACKGROUND_LAUNCH: '1', npm_config_arch: arch }
        })
    })
    const addon = join(scratch, 'worker-wait.node')
    const compiled = await runProcess({
      program: 'clang',
      args: [
        '-arch',
        arch === 'x64' ? 'x86_64' : 'arm64',
        '-O2',
        '-shared',
        '-fPIC',
        '-undefined',
        'dynamic_lookup',
        '-I',
        join(headers, 'include/node'),
        join(import.meta.dirname, '__fixtures__/darwin-terminal-worker-wait.c'),
        '-o',
        addon
      ],
      timeoutMs: 60_000
    })
    if (compiled.code !== 0) {
      throw new Error(compiled.stderr)
    }
    const result = await runProcess({
      program: executable,
      args: [
        join(import.meta.dirname, 'darwin-terminal-node-probe.cjs'),
        addon,
        stagedPty,
        scratch,
        `v${NODE_RUNTIME_PIN.version}`
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', UV_THREADPOOL_SIZE: '4' },
      timeoutMs: 60_000
    })
    if (result.code !== 0) {
      throw new Error(`Runtime proof failed (${result.code}): ${result.stderr}`)
    }
    if (JSON.parse(result.stdout.trim()).arch !== arch) {
      throw new Error(`Runtime proof used the wrong architecture; expected ${arch}`)
    }
    console.log(result.stdout.trim())
    if (process.env.ORCA_DARWIN_WORKER_STRESS === '1') {
      const stress = await runProcess({
        program: executable,
        args: [
          join(import.meta.dirname, 'darwin-terminal-worker-stress.cjs'),
          addon,
          stagedPty,
          scratch
        ],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', UV_THREADPOOL_SIZE: '4' },
        timeoutMs: 61 * 60_000
      })
      console.log(stress.stdout.trim())
      if (stress.code !== 0) {
        throw new Error(`Sequential worker stress failed: ${stress.stderr}`)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  await verifyDarwinTerminalNode(readDarwinVerificationArch(process.argv.slice(2)))
}
