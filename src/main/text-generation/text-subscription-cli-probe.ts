import { runProcess } from '@orca/process-host'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_POLL_MS } from '../rate-limits/service/service-types'
import { compareAppVersions } from '../../shared/app-version'
import type { TextGenerationRequest } from './source-control-generation-lanes'

type TextSubscriptionCliProbe = (
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string
) => Promise<string | null>

export function createTextSubscriptionCliProbe(options: {
  program: string
  cwd: string
  request: TextGenerationRequest
  current: () => boolean
}): TextSubscriptionCliProbe {
  const { program, cwd, request, current } = options
  return async (args, env, input) => {
    if (!current() || !request.claimSpawn()) {
      return null
    }
    let terminated = false
    const result = await runProcess({
      program,
      args,
      cwd,
      env,
      input,
      timeoutMs: Math.max(1, request.deadline - Date.now()),
      signal: request.signal,
      maxOutputBytes: 256 * 1024,
      killOnOutputLimit: true,
      terminationBarrier: true,
      onChildTerminated: () => {
        terminated = true
      }
    })
    return terminated &&
      current() &&
      result.code === 0 &&
      !result.timedOut &&
      !result.outputTruncated
      ? result.stdout
      : null
  }
}

const versionOutputsByInstall = new Map<string, { stamp: string; output: string }>()

async function cliInstallStamp(program: string) {
  if (!isAbsolute(program)) {
    return null
  }
  try {
    const path = await realpath(program)
    const info = await stat(path, { bigint: true })
    return { path, stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}` }
  } catch {
    return null
  }
}

// Version output belongs to the resolved install, so later requests skip the probe and its spawn slot.
export async function readTextSubscriptionCliVersion(
  program: string,
  probe: () => Promise<string | null>
): Promise<string | null> {
  const before = await cliInstallStamp(program)
  const cached = before && versionOutputsByInstall.get(before.path)
  if (cached && cached.stamp === before.stamp) {
    return cached.output
  }
  const output = await probe()
  if (output !== null && before) {
    const after = await cliInstallStamp(program)
    if (after?.path === before.path && after.stamp === before.stamp) {
      versionOutputsByInstall.set(before.path, { stamp: before.stamp, output })
    }
  }
  return output
}

export function nonEmptyModelListing<T>(items: T[]): T[] | null {
  return items.length ? items : null
}

type ModelListingEntry = { fingerprint: string; expiresAt: number; output: string }
const modelListingsByAccount = new Map<string, ModelListingEntry>()

/** Caches parsed listings per install, login, config and cwd so failover skips the probe spawn. */
export async function readTextSubscriptionModelListing<T>(options: {
  program: string
  accountId: string
  identity: string
  configuration: string
  cwd: string
  probe: () => Promise<string | null>
  parse: (output: string) => T | null
}): Promise<T | null> {
  const { program, accountId, probe, parse } = options
  const before = await cliInstallStamp(program)
  const key = before && JSON.stringify([before.path, accountId])
  const fingerprint = (stamp: string) =>
    createHash('sha256')
      .update(JSON.stringify([stamp, options.identity, options.configuration, options.cwd]))
      .digest('hex')
  const cached = key ? modelListingsByAccount.get(key) : undefined
  if (
    before &&
    cached?.fingerprint === fingerprint(before.stamp) &&
    Date.now() < cached.expiresAt
  ) {
    const models = parse(cached.output)
    if (models !== null) {
      return models
    }
  }
  const output = await probe()
  const models = output === null ? null : parse(output)
  if (key && output !== null && models !== null) {
    const after = await cliInstallStamp(program)
    if (after?.path === before.path && after.stamp === before.stamp) {
      modelListingsByAccount.set(key, {
        fingerprint: fingerprint(before.stamp),
        expiresAt: Date.now() + DEFAULT_POLL_MS,
        output
      })
    }
  }
  return models
}

const warnedUnsupportedVersions = new Set<string>()

// Newer CLIs keep the structured protocol; null output (failed or canceled probe) never warns.
export function supportsTextSubscriptionCliVersion(
  provider: 'Claude' | 'Codex',
  output: string | null,
  pattern: RegExp,
  minimum: string
): boolean {
  if (output === null) {
    return false
  }
  const version = pattern.exec(output.trim())?.[1]
  if (version && compareAppVersions(version, minimum) >= 0) {
    return true
  }
  const key = `${provider}:${version ?? 'unrecognized'}`
  if (!warnedUnsupportedVersions.has(key)) {
    warnedUnsupportedVersions.add(key)
    console.warn(
      `[text-generation] Subscription failover is unsupported for ${provider} CLI version ${version ?? '(unrecognized)'}; ${minimum} or newer is required.`
    )
  }
  return false
}
