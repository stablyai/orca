import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildAppImageCliWrapper } from './appimage-cli-wrapper'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const itRunsUnixShell = process.platform === 'win32' ? it.skip : it
const builderConfig = require('../../../config/electron-builder.config.cjs') as {
  files?: string[]
  asarUnpack?: string[]
  mac?: { extraResources?: { from?: string; to?: string }[] }
  linux?: { extraResources?: { from?: string; to?: string }[] }
  win?: { extraResources?: { from?: string; to?: string }[] }
}
const linuxLauncherAsset = new URL('../../../resources/linux/bin/orca-ide', import.meta.url)
const darwinLauncherAsset = new URL('../../../resources/darwin/bin/orca', import.meta.url)

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
      expect(content).toContain('export ELECTRON_RUN_AS_NODE=1')
      expect(content).toContain('exec "$ELECTRON" "$CLI" "$@"')
    }
  })

  itRunsUnixShell(
    'delivers SIGTERM to the Linux executable and releases its listener',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-linux-cli-signal-'))
      const appDir = join(root, 'Orca')
      const resourcesDir = join(appDir, 'resources')
      const launcherDir = join(resourcesDir, 'bin')
      const cliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
      const launcherPath = join(launcherDir, 'orca-ide')
      const electronPath = join(appDir, 'orca-ide')
      const statePath = join(root, 'listener-state.json')
      let executablePid: number | null = null
      let launcher: ReturnType<typeof spawn> | null = null
      try {
        await mkdir(launcherDir, { recursive: true })
        await mkdir(cliDir, { recursive: true })
        await copyFile(linuxLauncherAsset, launcherPath)
        await writeFile(join(cliDir, 'index.js'), '', 'utf8')
        await writeFile(
          electronPath,
          `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const server = net.createServer()
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.env.ORCA_TEST_LISTENER_STATE, JSON.stringify({
    pid: process.pid,
    port: server.address().port
  }))
})
const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
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
        const launcherExit = once(launcher, 'exit')
        launcher.kill('SIGTERM')
        await launcherExit

        expect(executablePid).toBe(launcherPid)
        await expect(waitForPortRelease(state.port)).resolves.toBe(true)
      } finally {
        if (launcher?.pid && isProcessAlive(launcher.pid)) {
          process.kill(launcher.pid, 'SIGTERM')
        }
        if (executablePid && isProcessAlive(executablePid)) {
          process.kill(executablePid, 'SIGTERM')
        }
        await rm(root, { recursive: true, force: true })
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

  itRunsUnixShell('runs the AppImage CLI wrapper through APPDIR at runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-appimage-cli-'))
    try {
      const appDir = join(root, 'Orca.AppDir')
      const cliDir = join(appDir, 'resources', 'app.asar.unpacked', 'out', 'cli')
      const cliPath = join(cliDir, 'index.js')
      const appImagePath = join(root, "Orca's AppImage.AppImage")
      const commandPath = join(root, 'orca-ide')
      await mkdir(cliDir, { recursive: true })
      await writeFile(
        cliPath,
        `exports.main = (argv) => {
  console.log(JSON.stringify({
    argv,
    appDir: process.env.APPDIR,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    orcaNodeOptions: process.env.ORCA_NODE_OPTIONS ?? null,
    nodeReplExternalModule: process.env.NODE_REPL_EXTERNAL_MODULE ?? null,
    orcaNodeReplExternalModule: process.env.ORCA_NODE_REPL_EXTERNAL_MODULE ?? null
  }))
}
`,
        'utf8'
      )
      await writeFile(
        appImagePath,
        `#!/usr/bin/env bash
export APPDIR="$FAKE_APPDIR"
exec node "$@"
`,
        { encoding: 'utf8', mode: 0o755 }
      )
      await writeFile(commandPath, buildAppImageCliWrapper(appImagePath), {
        encoding: 'utf8',
        mode: 0o755
      })

      const result = await execFileAsync(commandPath, ['--help', 'two words'], {
        env: {
          ...process.env,
          FAKE_APPDIR: appDir,
          NODE_OPTIONS: '--trace-warnings',
          NODE_REPL_EXTERNAL_MODULE: 'external-loader'
        }
      })
      const payload = JSON.parse(result.stdout) as {
        argv: string[]
        appDir: string
        runAsNode: string
        nodeOptions: string | null
        orcaNodeOptions: string | null
        nodeReplExternalModule: string | null
        orcaNodeReplExternalModule: string | null
      }

      expect(payload.argv).toEqual(['--help', 'two words'])
      expect(payload.appDir).toBe(appDir)
      expect(payload.runAsNode).toBe('1')
      expect(payload.nodeOptions).toBeNull()
      expect(payload.orcaNodeOptions).toBe('--trace-warnings')
      expect(payload.nodeReplExternalModule).toBeNull()
      expect(payload.orcaNodeReplExternalModule).toBe('external-loader')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function waitForListenerState(path: string): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as { pid: number; port: number }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
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
