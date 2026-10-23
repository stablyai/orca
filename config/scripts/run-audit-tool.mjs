import { runProcessSync } from '@orca/process-host'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const TOOL_ENTRIES = {
  'react-doctor': ['react-doctor', 'bin', 'react-doctor.js'],
  knip: ['knip', 'bin', 'knip.js']
}

export function auditToolEntry(tool, root = ROOT) {
  if (!Object.hasOwn(TOOL_ENTRIES, tool)) {
    throw new Error(`Unknown audit tool: ${tool}`)
  }
  return join(root, 'config', 'audit-tools', 'node_modules', ...TOOL_ENTRIES[tool])
}

export function installAuditTools(root = ROOT, run = runProcessSync) {
  const { command, prefixArgs } = resolvePnpmCliInvocation()
  return run({
    program: command,
    args: [
      ...prefixArgs,
      '--dir',
      join(root, 'config', 'audit-tools'),
      'install',
      '--frozen-lockfile',
      '--ignore-scripts'
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
}

export function runAuditTool(
  tool,
  args,
  { root = ROOT, run = runProcessSync, stdio = 'inherit' } = {}
) {
  const entry = auditToolEntry(tool, root)
  // Recheck the manifest and lock on every run; an old install must not bypass a reviewed update.
  const installed = installAuditTools(root, run)
  if (installed.code !== 0 || installed.signal || installed.timedOut) {
    return installed
  }
  return run({
    program: process.execPath,
    args: [entry, ...args],
    cwd: root,
    stdio,
    timeoutMs: null
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , tool, ...args] = process.argv
  const result = runAuditTool(tool, args)
  process.exitCode = result.code === 0 && !result.signal && !result.timedOut ? 0 : result.code || 1
}
