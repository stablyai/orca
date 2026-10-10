import { win32 } from 'node:path'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import type { PipedProcessSpec, ProcessSpec } from '@orca/process-host/process-spec'
import { resolveSpawn } from '@orca/process-host/spawn-resolution'

export const CODEX_MAINTENANCE_PROVIDER_EXIT = 'codex-maintenance-provider-exit'

const WINDOWS_MAINTENANCE_SUPERVISOR = `
const { spawn } = require('node:child_process')
const spec = JSON.parse(Buffer.from(process.env.ORCA_MAINTENANCE_SUPERVISOR_SPEC, 'base64').toString())
const env = { ...process.env }
delete env.ORCA_MAINTENANCE_SUPERVISOR_SPEC
delete env.ELECTRON_RUN_AS_NODE
if (spec.nodeOptions === undefined) delete env.NODE_OPTIONS
else env.NODE_OPTIONS = spec.nodeOptions
// Keep this owned root alive until the host has reaped every installer descendant.
const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env, windowsHide: true,
  windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const stream of [process.stdin, process.stdout, process.stderr, child.stdin, child.stdout, child.stderr]) {
  stream.on('error', () => {})
}
const report = (code, signal, error) => {
  process.send?.({ type: '${CODEX_MAINTENANCE_PROVIDER_EXIT}', code, signal, error })
}
child.once('error', (error) => report(null, null, error.message))
child.once('exit', (code, signal) => report(code, signal, null))
// An IPC disconnect means the owner died; this still-live pid owns the entire tree.
process.once('disconnect', () => {
  const killer = spawn(spec.taskkill, ['/pid', String(process.pid), '/t', '/f'], { cwd: spec.systemCwd, windowsHide: true, stdio: 'ignore' })
  killer.once('error', () => {})
})
`

export function codexMaintenanceWindowsSpawnSpec(input: ProcessSpec): PipedProcessSpec {
  const cwd = input.cwd ?? process.cwd()
  const resolved = resolveSpawn({ ...input, cwd }, 'win32')
  const env = { ...process.env, ...resolved.options.env }
  const taskkill = windowsSystem32Binary('taskkill.exe')
  const systemCwd = win32.dirname(taskkill)
  return {
    program: process.execPath,
    args: ['-e', WINDOWS_MAINTENANCE_SUPERVISOR],
    cwd: systemCwd,
    env: {
      ...env,
      NODE_OPTIONS: undefined,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_MAINTENANCE_SUPERVISOR_SPEC: Buffer.from(
        JSON.stringify({
          taskkill,
          systemCwd,
          file: resolved.file,
          args: resolved.args,
          cwd,
          windowsVerbatimArguments: resolved.options.windowsVerbatimArguments,
          nodeOptions: env.NODE_OPTIONS
        })
      ).toString('base64')
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    serialization: 'json'
  }
}
