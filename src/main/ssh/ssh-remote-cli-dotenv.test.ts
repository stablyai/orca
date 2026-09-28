import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { createRemoteCliInstallPlan } from './ssh-remote-cli-launcher'
import { getRemoteHostPlatform } from './ssh-remote-platform'

describe.skipIf(process.platform === 'win32')('remote CLI runtime dotenv arguments', () => {
  it.each(['bun', 'node'])('isolates Bun while preserving legacy %s invocation', async (name) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cli-dotenv-'))
    const server = createServer()
    try {
      await new Promise<void>((resolve) => server.listen(join(root, 'socket'), resolve))
      const runtime = join(root, name)
      writeFileSync(runtime, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
      chmodSync(runtime, 0o700)
      const plan = createRemoteCliInstallPlan({
        binDir: join(root, 'bin'),
        relayDir: join(root, 'relay'),
        nodePath: runtime,
        sockPath: join(root, 'socket'),
        hostPlatform: getRemoteHostPlatform('linux-x64')
      })
      for (const file of plan.files) {
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.contents)
      }
      const env = { ...process.env, ORCA_RELAY_NODE_PATH: runtime }
      const result = runProcessSync({
        program: '/bin/sh',
        args: [plan.launcherPath, 'status'],
        env
      })
      expect(result.code).toBe(0)
      const args = result.stdout.trim().split('\n')
      expect(args.includes('--no-env-file')).toBe(name === 'bun')
      expect(args.includes('--config=/dev/null')).toBe(name === 'bun')
      expect(args.includes('--no-install')).toBe(name === 'bun')
      expect(args.at(-1)).toBe('status')
      if (name === 'bun') {
        expect(args[0]).toBe('--no-env-file')
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  })
})

it.skipIf(process.platform === 'win32' || !process.env.BUN_EXECUTABLE)(
  'runs the remote Bun CLI without executing workspace configuration',
  async () => {
    const bun = process.env.BUN_EXECUTABLE
    if (!bun) {
      throw new Error('Missing Bun test runtime')
    }
    const root = mkdtempSync(join(tmpdir(), 'orca-remote-cli-config-'))
    const server = createServer()
    try {
      const socket = join(root, 'socket')
      await new Promise<void>((resolve) => server.listen(socket, resolve))
      const runtime = join(root, 'bun-runtime')
      symlinkSync(bun, runtime)
      writeFileSync(join(root, 'bunfig.toml'), 'preload = ["./preload.cjs"]\n')
      writeFileSync(join(root, 'preload.cjs'), 'throw new Error("Workspace preload executed")')
      writeFileSync(join(root, '.env'), 'ORCA_DOTENV_PROBE=loaded\n')
      const plan = createRemoteCliInstallPlan({
        binDir: join(root, 'bin'),
        relayDir: root,
        nodePath: runtime,
        sockPath: socket,
        hostPlatform: getRemoteHostPlatform('linux-x64')
      })
      for (const file of plan.files) {
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.contents)
      }
      writeFileSync(
        join(root, 'relay.js'),
        'console.log(JSON.stringify({cwd:process.cwd(),dotenv:process.env.ORCA_DOTENV_PROBE??null,args:process.argv.slice(2)}))'
      )
      const result = runProcessSync({
        program: '/bin/sh',
        args: [plan.launcherPath, 'two words', 'line\nbreak'],
        cwd: root,
        env: {
          ORCA_RELAY_NODE_PATH: runtime,
          ORCA_RELAY_DIR: root,
          ORCA_RELAY_SOCKET_PATH: socket,
          ORCA_RELAY_CREDENTIAL_FILE: `${socket}.credential`
        }
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        cwd: realpathSync(root),
        dotenv: null,
        args: [
          '--sock-path',
          socket,
          '--credential-file',
          `${socket}.credential`,
          '--orca-cli',
          'two words',
          'line\nbreak'
        ]
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  }
)
