import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  ORCAD_CLI_ENTRY_FILENAME,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME
} from '../../shared/orcad-artifacts'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { buildUnixCliLauncher } from '../cli/cli-dev-launcher'
import { resolveBundledOrcadRuntime } from './orcad-bundled-runtime'
import { skipForMissingInputs } from './orcad-node-slot-fixture'

const slotDir = resolve('out/orcad')
const cliEntry = join(slotDir, ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
const windowsLauncher = join(slotDir, ...ORCAD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
const runtime = existsSync(join(slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME))
  ? resolveBundledOrcadRuntime(slotDir)
  : null
const hasCli =
  runtime !== null &&
  existsSync(cliEntry) &&
  (process.platform !== 'win32' || existsSync(windowsLauncher))
const skip = skipForMissingInputs('artifact', hasCli ? [] : ['the packaged server CLI'])

/** The launcher the server would hand its children, pinned to `userData`. */
function serverCliLauncher(userData: string): string {
  if (process.platform === 'win32') {
    return windowsLauncher
  }
  const launcher = join(userData, 'orca')
  writeFileSync(launcher, buildUnixCliLauncher(runtime!, cliEntry, userData, 'node'), {
    mode: 0o700
  })
  return launcher
}

it.skipIf(skip)(
  'the packaged launcher delivers ask and resume RPCs to its owning host',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-rpc-'))
    const endpoint =
      process.platform === 'win32' ? `\\\\.\\pipe\\cli-${randomUUID()}` : join(root, 'rpc')
    const requests: { method: string; params: unknown }[] = []
    const server = createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) {
          return
        }
        const request: unknown = JSON.parse(buffer.slice(0, newline))
        if (
          typeof request !== 'object' ||
          request === null ||
          !('id' in request) ||
          !('method' in request)
        ) {
          return
        }
        if (typeof request.method !== 'string') {
          return
        }
        requests.push({
          method: request.method,
          params: 'params' in request ? request.params : null
        })
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result:
              request.method === 'status.get'
                ? {
                    capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY],
                    graphStatus: 'ready'
                  }
                : { answer: 'yes', messageId: 'msg_1', threadId: 'msg_1', timedOut: false },
            _meta: { runtimeId: 'runtime-owner' }
          })}\n`
        )
      })
    })
    try {
      await new Promise<void>((ready) => server.listen(endpoint, ready))
      const launcher = serverCliLauncher(root)
      writeFileSync(
        join(root, 'orca-runtime.json'),
        JSON.stringify({
          runtimeId: 'runtime-owner',
          pid: process.pid,
          startedAt: 1,
          authToken: 'fixture-token',
          transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }]
        })
      )
      const home = join(root, 'home')
      mkdirSync(home)
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
        ORCA_USER_DATA_PATH: root,
        ORCA_CLI_COMMAND: launcher,
        ORCA_ENVIRONMENT: 'stale-shell-selection',
        ORCA_PAIRING_CODE: 'stale-pairing',
        ORCA_BACKGROUND_LAUNCH: '1',
        ...(process.platform === 'win32' ? { ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER: '1' } : {})
      }
      for (const [flag, value] of [
        ['--question', 'Proceed?'],
        ['--resume', 'msg_1']
      ]) {
        const result = await runProcess({
          program: launcher,
          args: ['orchestration', 'ask', '--from', 'term_worker', flag, value, '--json'],
          env,
          cwd: home,
          timeoutMs: 15_000
        })
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ result: { answer: 'yes' } })
      }
      expect(requests.filter((request) => request.method === 'orchestration.ask')).toMatchObject([
        { params: { question: 'Proceed?' } },
        { params: { resume: 'msg_1' } }
      ])
      for (const request of requests.filter((request) => request.method === 'orchestration.ask')) {
        expect(request.params).not.toHaveProperty('compatibilityWindowsCommand')
      }
      const version = await runProcess({
        program: launcher,
        args: ['--version'],
        env,
        timeoutMs: 15_000
      })
      const packageMetadata: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
      expect(version.code, version.stderr).toBe(0)
      expect(version.stdout.trim()).toBe(
        typeof packageMetadata === 'object' &&
          packageMetadata !== null &&
          'version' in packageMetadata
          ? packageMetadata.version
          : null
      )
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
      rmSync(root, { recursive: true, force: true })
    }
  },
  45_000
)
