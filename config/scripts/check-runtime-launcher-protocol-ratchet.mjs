// R3 gate (docs/reference/node-runtime-design.html, D7.1): swapping the process that hosts orcad
// or the daemon is not a daemon protocol change, so one PR must not do both. A bump riding along
// with a runtime swap would strand every live terminal on upgrade and rollback at once.
// Usage: node check-runtime-launcher-protocol-ratchet.mjs --base <ref>
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DAEMON_PROTOCOL_SOURCE_PATH, parseDaemonProtocolFacts } from './daemon-protocol-facts.mjs'

/** Files that decide which runtime executable launches orcad or the terminal daemon. */
export const RUNTIME_LAUNCHER_PATHS = [
  // orcad handoff to its bundled runtime, and the pinned runtimes it can hand off to.
  'src/main/orcad/orcad-bundled-runtime.ts',
  'src/main/orcad/launcher.ts',
  'config/scripts/orcad-entry-build.mjs',
  'src/shared/node-runtime-pin.ts',
  'src/main/ssh/pinned-runtime-materializer.ts',
  'src/main/ssh/runtime-archive-download.ts',
  'src/main/ssh/orcad-remote-node-runtime.ts',
  // orcad slot layout: which runtime file a packaged slot carries.
  'src/shared/orcad-artifacts.ts',
  'config/scripts/build-orcad.mjs',
  'config/scripts/build-orcad-node.mjs',
  'config/scripts/build-orcad-template.mjs',
  // Remote slot runtime selection.
  'src/main/ssh/orcad-remote-runtime.ts',
  // Terminal daemon host launch: which executable the daemon child is forked from.
  'src/main/daemon/daemon-launched-child.ts',
  'src/main/daemon/daemon-launched-child-spawn.ts',
  'src/main/daemon/daemon-out-of-process-launcher.ts',
  'src/main/daemon/daemon-host-relocation.ts',
  'src/main/daemon/daemon-host-manifest.ts'
]

export const RUNTIME_PROTOCOL_OVERRIDE_ENV = 'ORCA_ALLOW_RUNTIME_LAUNCHER_PROTOCOL_BUMP'
export const RUNTIME_PROTOCOL_OVERRIDE_LABEL = 'allow-runtime-launcher-protocol-bump'

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  })
}

/**
 * @param {{ changedFiles: string[], baseProtocolVersion: number, candidateProtocolVersion: number, overridden: boolean }} input
 */
export function assessRuntimeLauncherProtocolRatchet({
  changedFiles,
  baseProtocolVersion,
  candidateProtocolVersion,
  overridden
}) {
  const launcherChanges = RUNTIME_LAUNCHER_PATHS.filter((path) => changedFiles.includes(path))
  const protocolChanged = baseProtocolVersion !== candidateProtocolVersion
  const violated = protocolChanged && launcherChanges.length > 0
  const lines = [
    `daemon PROTOCOL_VERSION: base ${baseProtocolVersion}, candidate ${candidateProtocolVersion}`,
    launcherChanges.length > 0
      ? `runtime launcher files changed: ${launcherChanges.join(', ')}`
      : 'runtime launcher files changed: none'
  ]
  if (!violated) {
    lines.push('OK: this change does not both swap a runtime launcher and bump the daemon protocol')
  } else if (overridden) {
    lines.push(
      `OVERRIDDEN: launcher change and protocol bump together, allowed by ${RUNTIME_PROTOCOL_OVERRIDE_ENV}`
    )
  } else {
    lines.push(
      'FAIL: split the protocol bump and the runtime launcher change into separate PRs (D7.1 R3), ' +
        `or apply the "${RUNTIME_PROTOCOL_OVERRIDE_LABEL}" label and re-run the workflow with a new push.`
    )
  }
  return { ok: !violated || overridden, violated, lines }
}

export function isOverrideEnabled(env = process.env) {
  return ['1', 'true'].includes(env[RUNTIME_PROTOCOL_OVERRIDE_ENV]?.trim().toLowerCase() ?? '')
}

export function checkRuntimeLauncherProtocolRatchet({ repoRoot, base, env = process.env }) {
  // Why diff against the working tree: CI's tree is HEAD, and a local run also sees unstaged edits.
  const changedFiles = git(repoRoot, ['diff', '--name-only', '--no-renames', base, '--'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const baseFacts = parseDaemonProtocolFacts(
    git(repoRoot, ['show', `${base}:${DAEMON_PROTOCOL_SOURCE_PATH}`]),
    `${base}:${DAEMON_PROTOCOL_SOURCE_PATH}`
  )
  const candidateFacts = parseDaemonProtocolFacts(
    readFileSync(join(repoRoot, DAEMON_PROTOCOL_SOURCE_PATH), 'utf8'),
    DAEMON_PROTOCOL_SOURCE_PATH
  )
  return assessRuntimeLauncherProtocolRatchet({
    changedFiles,
    baseProtocolVersion: baseFacts.protocolVersion,
    candidateProtocolVersion: candidateFacts.protocolVersion,
    overridden: isOverrideEnabled(env)
  })
}

function parseArgs(argv) {
  const index = argv.indexOf('--base')
  const value = index === -1 ? undefined : argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error('--base <ref> is required (the pull request diff base)')
  }
  return { base: value }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = resolve(import.meta.dirname, '..', '..')
  try {
    const { base } = parseArgs(process.argv.slice(2))
    const result = checkRuntimeLauncherProtocolRatchet({ repoRoot, base })
    for (const line of result.lines) {
      console.log(line)
    }
    if (!result.ok) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`runtime launcher protocol ratchet failed: ${error.message}`)
    process.exitCode = 1
  }
}
