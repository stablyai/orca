import { stat, realpath } from 'node:fs/promises'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import {
  codexCliInstallation,
  parseCodexCliVersion,
  type CodexCliInstallation
} from '../../shared/codex-cli-installation'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { resolveSpawn } from '@orca/process-host/spawn-resolution'
import { readAgentCliVersion } from '../agent-cli-version-probe'
import { resolveLocalExecutionCommand } from '../ipc/command-path-resolver'
import { CodexCliInstallationCache } from './codex-cli-installation-cache'
import { codexNpmInstallationFiles } from './codex-npm-installation-files'

const cache = new CodexCliInstallationCache()
const configurationSecret = randomBytes(32)

async function stamp(file: string): Promise<string> {
  try {
    const value = await stat(file)
    return `${file}:${value.ino}:${value.mtimeMs}:${value.ctimeMs}:${value.size}`
  } catch {
    return `${file}:unverifiable`
  }
}

export function invalidateCodexCliInstallation(): void {
  cache.clear()
}

async function codexCliPackagePaths(
  input: Pick<ProcessSpec, 'program' | 'env'>
): Promise<string[]> {
  const resolved = resolveSpawn(input, process.platform)
  const target = await realpath(input.program).catch(() => input.program)
  const launchers = [target, ...resolved.args.filter(isAbsolute)]
  return [...new Set(launchers.map((file) => join(dirname(dirname(file)), 'package.json')))]
}

async function binaryFingerprint(input: Pick<ProcessSpec, 'program' | 'env'>): Promise<string> {
  const resolved = resolveSpawn(input, process.platform)
  const target = await realpath(input.program).catch(() => input.program)
  const packages = await codexCliPackagePaths(input)
  const files = new Set([
    input.program,
    target,
    resolved.file,
    ...resolved.args.filter(isAbsolute),
    // npm can keep its launcher unchanged while replacing the package underneath it.
    ...packages,
    ...(await codexNpmInstallationFiles(packages))
  ])
  return JSON.stringify(await Promise.all([...files].map(stamp)))
}

export async function readCodexCliInstallation(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>
): Promise<CodexCliInstallation> {
  return (await readCodexCliInstallationEvidence(input)).installation
}

export async function readCodexCliInstallationEvidence(
  input: Pick<ProcessSpec, 'program' | 'cwd' | 'env'>
) {
  const cwd = input.cwd ?? process.cwd()
  const environment = Object.entries({ ...process.env, ...input.env }).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  const configuration = JSON.stringify([input.program, cwd, environment])
  // A host-private salt keeps low-entropy secrets out of client-visible identities.
  const configurationId = createHmac('sha256', configurationSecret)
    .update(configuration)
    .digest('hex')
  const immediate = (installation: CodexCliInstallation) => ({
    installation,
    expiresAt: Date.now() + 30_000,
    configurationId
  })
  const selected = await resolveLocalExecutionCommand(input.program, { ...input, cwd })
  if (selected.status !== 'resolved') {
    return immediate(codexCliInstallation(selected.status !== 'missing', null))
  }
  const program = selected.program
  const launch = { ...input, program, cwd }
  const fingerprint = await binaryFingerprint(launch)
  const context = createHash('sha256').update(configuration).digest('hex')
  const evidence = await cache.readEvidence(
    `native:${program}:${context}`,
    fingerprint,
    async () => {
      const result = await readAgentCliVersion(launch, parseCodexCliVersion)
      return codexCliInstallation(true, result.version)
    }
  )
  return { ...evidence, configurationId }
}
