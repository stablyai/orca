import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { runProcess, spawnProcess } from '@orca/process-host'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import { resolveBundledOrcadRuntime } from './orcad-bundled-runtime'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME
} from '../../shared/orcad-artifacts'
import { skipForMissingInputs } from './orcad-node-slot-fixture'
import {
  killChildAndWait,
  killProfileDaemons,
  removeTestRoot
} from './orcad-daemon-teardown-fixture'

const slotDir = resolve('out/orcad')
const runtime = existsSync(join(slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME))
  ? resolveBundledOrcadRuntime(slotDir)
  : null
const skip = skipForMissingInputs('artifact', runtime ? [] : ['a Node orcad slot in out/orcad'])

it.skipIf(skip)(
  'a session child runs the server CLI against its owning server',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-cli-'))
    const home = join(root, 'home')
    mkdirSync(home)
    const userData = join(root, 'state')
    mkdirSync(userData)
    writeFileSync(
      join(userData, 'orca-data.json'),
      JSON.stringify({ settings: { agentStatusHooksEnabled: false } })
    )
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin',
      TEMP: root,
      TMP: root,
      TMPDIR: root,
      CODEX_HOME: join(home, 'codex'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      ORCA_USER_DATA: userData,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1'
    }
    const child = spawnProcess({
      program: runtime!,
      args: [
        join(slotDir, 'orcad.js'),
        '--bind',
        '127.0.0.1',
        '--port',
        '0',
        '--no-pairing',
        '--json'
      ],
      env,
      timeoutMs: null
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    try {
      await new Promise<void>((ready, reject) => {
        let stdout = ''
        const timer = setTimeout(
          () => reject(new Error(`server readiness timed out: ${stderr.slice(-2000)}`)),
          120_000
        )
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
          if (stdout.includes('\n')) {
            clearTimeout(timer)
            ready()
          }
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`server exited ${String(code)}: ${stderr.slice(-2000)}`))
        })
      })
      // The server writes its profile launcher on Unix; Windows ships a native one in the slot.
      const launcher =
        process.platform === 'win32'
          ? join(slotDir, ...ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
          : join(userData, 'cli', 'bin', 'orca')
      expect(existsSync(launcher)).toBe(true)
      installFakeAppEnvironment({
        getPath: () => userData,
        isPackaged: () => true,
        getCliLauncherPath: () => launcher
      })
      const childEnv = structuredSessionChildIdentityEnv('claude_test-session', {
        PATH: env.PATH ?? '',
        ORCA_ENVIRONMENT: 'stale-shell-selection',
        ORCA_PAIRING_CODE: 'stale-pairing',
        ORCA_REMOTE_PAIRING: 'stale-remote-pairing'
      })
      const result = await runProcess({
        program: childEnv.ORCA_CLI_COMMAND!,
        args: ['status', '--json'],
        env: { ...env, ...childEnv },
        cwd: home,
        timeoutMs: 15_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        result: {
          app: { running: true, pid: child.pid },
          runtime: { reachable: true, state: 'ready' }
        }
      })
      const skill = await runProcess({
        program: childEnv.ORCA_CLI_COMMAND!,
        args: ['skills', 'get', 'orchestration'],
        env: { ...env, ...childEnv },
        timeoutMs: 15_000
      })
      expect(skill.code, skill.stderr).toBe(0)
      expect(skill.stdout).toContain('Worker obligations')
      const version = await runProcess({
        program: childEnv.ORCA_CLI_COMMAND!,
        args: ['--version'],
        env: { ...env, ...childEnv },
        timeoutMs: 15_000
      })
      expect(version.code, version.stderr).toBe(0)
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u)
    } finally {
      await killChildAndWait(child)
      await killProfileDaemons(userData)
      await removeTestRoot(root)
    }
  },
  150_000
)
