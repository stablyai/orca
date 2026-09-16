import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const itRunsUnixShell = process.platform === 'win32' ? it.skip : it
const unixTerminationSignals = ['SIGINT', 'SIGTERM'] as const
const builderConfig = require('../../../config/electron-builder.config.cjs') as {
  files?: string[]
  asarUnpack?: string[]
  mac?: { extraResources?: { from?: string; to?: string }[] }
  linux?: { extraResources?: { from?: string; to?: string }[] }
  win?: { extraResources?: { from?: string; to?: string }[] }
}
const linuxLauncherAsset = new URL('../../../resources/linux/bin/orca-ide', import.meta.url)
const darwinLauncherAsset = new URL('../../../resources/darwin/bin/orca', import.meta.url)
const unixLauncherFixtures = [
  {
    name: 'Linux',
    asset: linuxLauncherAsset,
    appDir: ['Orca'],
    launcher: ['resources', 'bin', 'orca-ide'],
    executable: ['orca-ide'],
    cli: ['resources', 'app.asar.unpacked', 'out', 'cli', 'index.js']
  },
  {
    name: 'macOS',
    asset: darwinLauncherAsset,
    appDir: ['Orca.app'],
    launcher: ['Contents', 'Resources', 'bin', 'orca'],
    executable: ['Contents', 'MacOS', 'Orca'],
    cli: ['Contents', 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js']
  }
] as const

describe('packaged CLI assets', () => {
  it('ships embedded skill guides with the CLI instead of source Markdown', () => {
    // Why: `skills get` must work from the packaged CLI without falling back to
    // authoring-only files that do not exist in installed applications.
    expect(builderConfig.asarUnpack).toContain('out/cli/**')
    expect(builderConfig.files).toContain('!skill-guides{,/**/*}')
  })

  it('copies runtime dependencies used before Electron asar integration is available', () => {
    const runtimeResourceTargets = new Set(
      [
        ...(builderConfig.mac?.extraResources ?? []),
        ...(builderConfig.linux?.extraResources ?? []),
        ...(builderConfig.win?.extraResources ?? [])
      ].map((resource) => normalizeResourceTarget(resource.to))
    )

    expect([...runtimeResourceTargets]).toEqual(
      expect.arrayContaining([
        join('node_modules', 'ws'),
        join('node_modules', 'tweetnacl'),
        join('node_modules', 'zod'),
        join('node_modules', 'yaml'),
        join('node_modules', 'jsonc-parser'),
        join('node_modules', 'node-pty'),
        join('node_modules', 'sherpa-onnx-darwin-${arch}'),
        join('node_modules', 'sherpa-onnx-linux-${arch}'),
        join('node_modules', 'sherpa-onnx-win-x64')
      ])
    )
  })

  function normalizeResourceTarget(target: string | undefined): string | undefined {
    return target?.replace(/[\\/]/g, sep)
  }

  itRunsUnixShell('keeps the Linux launcher executable in packaged resources', async () => {
    const launcherStats = await stat(linuxLauncherAsset)
    expect(launcherStats.mode & 0o111).not.toBe(0)
  })

  itRunsUnixShell('replaces the shell process in packaged Unix launchers', async () => {
    for (const launcher of [linuxLauncherAsset, darwinLauncherAsset]) {
      const content = await readFile(launcher, 'utf8')
      expect(content).toContain('ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$CLI" "$@"')
    }
  })

  it('retries an incomplete listener-state write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-listener-state-'))
    const statePath = join(root, 'listener-state.json')
    const expectedState = { pid: 1234, port: 5678 }
    await writeFile(statePath, '{"pid":', 'utf8')
    const completedWrite = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        writeFile(statePath, JSON.stringify(expectedState), 'utf8').then(resolve, reject)
      }, 50)
    })

    try {
      await expect(waitForListenerState(statePath)).resolves.toEqual(expectedState)
    } finally {
      await completedWrite
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { state: { pid: '1234', port: 5678 }, reason: 'non-numeric pid' },
    { state: { pid: 0, port: 5678 }, reason: 'non-positive pid' },
    { state: { pid: 1234, port: '5678' }, reason: 'non-numeric port' },
    { state: { pid: 1234, port: 65_536 }, reason: 'out-of-range port' }
  ])('rejects $reason in listener state', async ({ state }) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-listener-state-'))
    const statePath = join(root, 'listener-state.json')
    try {
      await writeFile(statePath, JSON.stringify(state), 'utf8')
      await expect(waitForListenerState(statePath)).rejects.toThrow(
        'Invalid launcher listener state'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itRunsUnixShell.each(unixLauncherFixtures)(
    'delivers Unix termination signals to the $name executable and releases its listener',
    async (launcherFixture) => {
      for (const signal of unixTerminationSignals) {
        const root = await mkdtemp(join(tmpdir(), 'orca-unix-cli-signal-'))
        const appDir = join(root, ...launcherFixture.appDir)
        const launcherPath = join(appDir, ...launcherFixture.launcher)
        const electronPath = join(appDir, ...launcherFixture.executable)
        const cliPath = join(appDir, ...launcherFixture.cli)
        const statePath = join(root, `${signal}-listener-state.json`)
        let executablePid: number | null = null
        let launcher: ReturnType<typeof spawn> | null = null
        try {
          await mkdir(dirname(launcherPath), { recursive: true })
          await mkdir(dirname(electronPath), { recursive: true })
          await mkdir(dirname(cliPath), { recursive: true })
          await copyFile(launcherFixture.asset, launcherPath)
          await writeFile(cliPath, '', 'utf8')
          await writeFile(
            electronPath,
            `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const server = net.createServer()
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.ORCA_TEST_LISTENER_STATE, JSON.stringify({
    pid: process.pid,
    port: server.address().port
  }))
})
`,
            { encoding: 'utf8', mode: 0o755 }
          )

          launcher = spawn(launcherPath, [], {
            env: { ...process.env, ORCA_TEST_LISTENER_STATE: statePath },
            stdio: 'ignore'
          })
          const state = await waitForListenerState(statePath)
          executablePid = state.pid
          const launcherPid = launcher.pid
          const launcherExitPromise = waitForChildExit(launcher, 5_000)
          launcher.kill(signal)
          const launcherExit = await launcherExitPromise
          const exitCode = launcherExit?.[0]
          const exitSignal = launcherExit?.[1]

          expect.soft(executablePid).toBe(launcherPid)
          expect.soft(launcherExit).not.toBeNull()
          expect.soft(exitCode).toBe(0)
          expect.soft(exitSignal).toBeNull()
          expect.soft(await waitForPortRelease(state.port)).toBe(true)
        } finally {
          if (launcher?.pid) {
            await terminateSyntheticProcess(launcher.pid)
          }
          if (executablePid && executablePid !== launcher?.pid) {
            await terminateSyntheticProcess(executablePid)
          }
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  )

  itRunsUnixShell(
    'runs the Linux launcher from its packaged path and installed symlink',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-linux-cli-'))
      try {
        const appDir = join(root, 'Orca')
        const resourcesDir = join(appDir, 'resources')
        const launcherDir = join(resourcesDir, 'bin')
        const cliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
        const launcherPath = join(launcherDir, 'orca-ide')
        const electronPath = join(appDir, 'orca-ide')
        const cliPath = join(cliDir, 'index.js')

        await mkdir(launcherDir, { recursive: true })
        await mkdir(cliDir, { recursive: true })
        await copyFile(linuxLauncherAsset, launcherPath)
        expect((await stat(launcherPath)).mode & 0o111).not.toBe(0)
        await writeFile(cliPath, '', 'utf8')
        await writeFile(
          electronPath,
          `#!/usr/bin/env bash
printf 'electron=%s\\n' "$0"
printf 'run_as_node=%s\\n' "\${ELECTRON_RUN_AS_NODE-}"
printf 'arg=%s\\n' "$@"
`,
          { encoding: 'utf8', mode: 0o755 }
        )

        const direct = await execFileAsync(launcherPath, ['--help'])
        expect(direct.stdout).toContain(`electron=${electronPath}`)
        expect(direct.stdout).toContain('run_as_node=1')
        expect(direct.stdout).toContain(`arg=${cliPath}`)
        expect(direct.stdout).toContain('arg=--help')

        const homeDir = join(root, 'home')
        const commandDir = join(homeDir, '.local', 'bin')
        const commandPath = join(commandDir, 'orca-ide')
        await mkdir(commandDir, { recursive: true })
        await mkdir(join(homeDir, 'orca'), { recursive: true })
        await symlink(launcherPath, commandPath)

        const symlinked = await execFileAsync(commandPath, ['--help'], {
          env: { ...process.env, HOME: homeDir }
        })
        expect(symlinked.stdout).toContain(`electron=${electronPath}`)
        expect(symlinked.stdout).toContain('run_as_node=1')
        expect(symlinked.stdout).toContain(`arg=${cliPath}`)
        expect(symlinked.stdout).toContain('arg=--help')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  // Why: registration on every Linux install method now points at this one
  // launcher, so its env sanitation and argv passthrough are the contract the
  // AppImage, deb, and extracted-tree commands all depend on.
  itRunsUnixShell('sanitizes node env and forwards argv verbatim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-linux-cli-env-'))
    try {
      const appDir = join(root, 'Orca')
      const resourcesDir = join(appDir, 'resources')
      const launcherDir = join(resourcesDir, 'bin')
      const cliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
      const launcherPath = join(launcherDir, 'orca-ide')
      const cliPath = join(cliDir, 'index.js')

      await mkdir(launcherDir, { recursive: true })
      await mkdir(cliDir, { recursive: true })
      await copyFile(linuxLauncherAsset, launcherPath)
      await writeFile(cliPath, '', 'utf8')
      await writeFile(
        join(appDir, 'orca-ide'),
        `#!/usr/bin/env bash
node -e 'console.log(JSON.stringify({
  argv: process.argv.slice(1),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  orcaNodeOptions: process.env.ORCA_NODE_OPTIONS ?? null,
  nodeReplExternalModule: process.env.NODE_REPL_EXTERNAL_MODULE ?? null,
  orcaNodeReplExternalModule: process.env.ORCA_NODE_REPL_EXTERNAL_MODULE ?? null
}))' -- "$@"
`,
        { encoding: 'utf8', mode: 0o755 }
      )

      const result = await execFileAsync(launcherPath, ['--help', 'two words'], {
        env: {
          ...process.env,
          NODE_OPTIONS: '--trace-warnings',
          NODE_REPL_EXTERNAL_MODULE: 'external-loader'
        }
      })
      const payload = JSON.parse(result.stdout) as {
        argv: string[]
        runAsNode: string
        nodeOptions: string | null
        orcaNodeOptions: string | null
        nodeReplExternalModule: string | null
        orcaNodeReplExternalModule: string | null
      }

      expect(payload.argv).toEqual([cliPath, '--help', 'two words'])
      expect(payload.runAsNode).toBe('1')
      // Why: Electron's node bootstrap must not inherit these, but the CLI
      // still needs to see what the user set.
      expect(payload.nodeOptions).toBeNull()
      expect(payload.orcaNodeOptions).toBe('--trace-warnings')
      expect(payload.nodeReplExternalModule).toBeNull()
      expect(payload.orcaNodeReplExternalModule).toBe('external-loader')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itRunsUnixShell('keeps Linux serve on the CLI entrypoint in node mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-linux-cli-serve-'))
    try {
      const appDir = join(root, 'Orca')
      const resourcesDir = join(appDir, 'resources')
      const launcherDir = join(resourcesDir, 'bin')
      const cliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
      const launcherPath = join(launcherDir, 'orca-ide')
      const appRunPath = join(appDir, 'AppRun')
      const electronPath = join(appDir, 'orca-ide')
      const cliPath = join(cliDir, 'index.js')
      const statePath = join(root, 'launch-state.json')

      await mkdir(launcherDir, { recursive: true })
      await mkdir(cliDir, { recursive: true })
      await copyFile(linuxLauncherAsset, launcherPath)
      await writeFile(cliPath, '', 'utf8')
      // An accidental AppRun handoff would skip CLI validation and fail this contract.
      await writeFile(
        appRunPath,
        `#!/usr/bin/env bash
printf 'unexpected AppRun handoff\n' >&2
exit 97
`,
        { encoding: 'utf8', mode: 0o755 }
      )
      await writeFile(
        electronPath,
        `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ORCA_TEST_LAUNCH_STATE, JSON.stringify({
  argv: process.argv.slice(2),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null
}))
`,
        { encoding: 'utf8', mode: 0o755 }
      )

      await execFileAsync(launcherPath, ['serve', '--recipe-json', '--project-root', '/tmp/repo'], {
        env: { ...process.env, ORCA_TEST_LAUNCH_STATE: statePath }
      })
      const payload = JSON.parse(await readFile(statePath, 'utf8')) as {
        argv: string[]
        runAsNode: string | null
      }
      expect(payload.argv).toEqual([
        cliPath,
        'serve',
        '--recipe-json',
        '--project-root',
        '/tmp/repo'
      ])
      expect(payload.runAsNode).toBe('1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function waitForListenerState(path: string): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const state: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (
        typeof state !== 'object' ||
        state === null ||
        !('pid' in state) ||
        typeof state.pid !== 'number' ||
        !Number.isInteger(state.pid) ||
        state.pid <= 0 ||
        !('port' in state) ||
        typeof state.port !== 'number' ||
        !Number.isInteger(state.port) ||
        state.port <= 0 ||
        state.port > 65_535
      ) {
        throw new Error('Invalid launcher listener state')
      }
      return { pid: state.pid, port: state.port }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error('Timed out waiting for launcher listener state')
}

async function waitForPortRelease(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (!connected) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<readonly [number | null, NodeJS.Signals | null] | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve([child.exitCode, child.signalCode])
      return
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout)
      resolve([code, signal])
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(null)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateSyntheticProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  if (await waitForProcessExit(pid, 1_000)) {
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  if (!(await waitForProcessExit(pid, 1_000))) {
    throw new Error(`Failed to terminate synthetic launcher process ${pid}`)
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return !isProcessAlive(pid)
}
