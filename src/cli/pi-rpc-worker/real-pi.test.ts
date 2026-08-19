import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildPiChildEnvironment,
  buildPiExecutableInvocation,
  buildPiRpcArgv,
  resolvePiExecutable
} from './child-environment'
import { materializeLifecycleExtension } from './extension-cache'
import { HANDSHAKE_STATUS_KEY, PI_RPC_WORKER_ACTIVE_TOOL_NAMES } from './extension-source'
import { StrictJsonlDecoder } from './jsonl-decoder'
import type { RpcObject } from './types'

const runRealHostFixture = process.env.ORCA_RUN_REAL_PI_RPC_FIXTURE === '1' ? it : it.skip
const cleanupRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('real Pi RPC host fixture', () => {
  runRealHostFixture(
    'loads the content-addressed lifecycle extension and answers documented RPC commands',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-real-pi-rpc-'))
      cleanupRoots.push(root)
      const nonce = 'real-host-fixture-nonce'
      const extension = await materializeLifecycleExtension(nonce, join(root, 'cache'))
      const agentDirectory = join(root, 'hostile-agent-directory')
      const extensionDirectory = join(agentDirectory, 'extensions')
      await mkdir(extensionDirectory, { recursive: true })
      await writeFile(
        join(extensionDirectory, 'hostile-global.ts'),
        `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "hostile_global_tool",
    description: "must never load",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "unsafe" }] }; }
  });
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("hostile-global", "loaded"));
}
`
      )
      await writeFile(join(agentDirectory, 'SYSTEM.md'), 'HOSTILE GLOBAL SYSTEM PROMPT')
      await writeFile(join(agentDirectory, 'APPEND_SYSTEM.md'), 'HOSTILE GLOBAL APPEND PROMPT')
      await writeFile(join(agentDirectory, 'AGENTS.md'), 'HOSTILE GLOBAL CONTEXT')
      await writeFile(
        join(agentDirectory, 'settings.json'),
        JSON.stringify({ defaultTools: ['bash', 'read', 'edit', 'write'] })
      )
      const environment = buildPiChildEnvironment(process.env)
      environment.PI_CODING_AGENT_DIR = agentDirectory
      environment.PI_OFFLINE = '1'
      environment.PI_SKIP_VERSION_CHECK = '1'
      const executable = resolvePiExecutable(environment, process.platform, process.cwd())
      const invocation = buildPiExecutableInvocation(executable, process.execPath, false)
      const child = spawn(
        invocation.executable,
        [...invocation.argsPrefix, ...buildPiRpcArgv(extension.path)],
        {
          cwd: process.cwd(),
          env: { ...environment, ...invocation.env },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      const records: RpcObject[] = []
      let stderr = ''
      const decoder = new StrictJsonlDecoder((record) => records.push(record))
      child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_192)
      })

      try {
        const handshake = await waitForRecord(
          records,
          (record) =>
            record.type === 'extension_ui_request' &&
            record.method === 'setStatus' &&
            record.statusKey === HANDSHAKE_STATUS_KEY,
          20_000
        )
        expect(handshake.statusText).toBe(
          JSON.stringify({
            protocol: 'orca.pi.rpc-worker.handshake',
            version: 1,
            nonce,
            source: extension.selectedSource,
            workspaceRuntime: {
              sha256: extension.workspaceRuntime.sourceHash,
              sources: [
                extension.workspaceRuntime.securitySource,
                extension.workspaceRuntime.mutationSource
              ]
            },
            tools: PI_RPC_WORKER_ACTIVE_TOOL_NAMES.map((name) => ({
              name,
              source: extension.selectedSource
            }))
          })
        )
        expect(PI_RPC_WORKER_ACTIVE_TOOL_NAMES).not.toContain('bash')
        expect(records).not.toContainEqual(expect.objectContaining({ statusKey: 'hostile-global' }))

        child.stdin.write(`${JSON.stringify({ id: 'state-1', type: 'get_state' })}\n`)
        const state = await waitForRecord(
          records,
          (record) => record.type === 'response' && record.id === 'state-1',
          10_000
        )
        expect(state.success).toBe(true)
        expect(stderr).not.toContain('Orca lifecycle tool selection changed')
      } finally {
        child.kill('SIGTERM')
        await Promise.race([
          new Promise<void>((resolve) => child.once('close', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000))
        ])
      }
    },
    30_000
  )
})

async function waitForRecord(
  records: RpcObject[],
  predicate: (record: RpcObject) => boolean,
  timeoutMs: number
): Promise<RpcObject> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = records.find(predicate)
    if (record) {
      return record
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(
    `Timed out waiting for real Pi RPC record; saw ${JSON.stringify(records.slice(-5))}`
  )
}
