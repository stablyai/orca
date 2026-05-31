import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

type CodexConfigSyncState = {
  lastMirrorableSystemConfigDigest: string
  lastSystemConfigUnitDigests: Record<string, string>
}

type CodexConfigSyncStateRead =
  | {
      status: 'valid'
      digest: string
      unitDigests: Record<string, string> | null
      needsRewrite: boolean
    }
  | {
      status: 'legacy'
      systemConfig: string
    }
  | {
      status: 'missing'
    }
  | {
      status: 'invalid'
    }

const SYSTEM_CONFIG_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

function getCodexConfigSyncStatePath(): string {
  return join(dirname(getOrcaManagedCodexHomePath()), 'config-sync-state.json')
}

export function getSystemCodexConfigDigest(systemConfig: string): string {
  return `sha256:${createHash('sha256').update(systemConfig).digest('hex')}`
}

export function readLastSyncedSystemCodexConfigState(): CodexConfigSyncStateRead {
  try {
    const parsed = JSON.parse(readFileSync(getCodexConfigSyncStatePath(), 'utf-8')) as unknown
    const isStateObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    const hasLegacySystemConfig = isStateObject && Object.hasOwn(parsed, 'lastSystemConfig')
    const lastSystemConfig =
      isStateObject &&
      typeof (parsed as { lastSystemConfig?: unknown }).lastSystemConfig === 'string'
        ? (parsed as { lastSystemConfig: string }).lastSystemConfig
        : null
    const lastMirrorableSystemConfigDigest =
      isStateObject &&
      typeof (parsed as { lastMirrorableSystemConfigDigest?: unknown })
        .lastMirrorableSystemConfigDigest === 'string'
        ? (parsed as CodexConfigSyncState).lastMirrorableSystemConfigDigest
        : null
    const legacySystemConfigDigest =
      isStateObject &&
      typeof (parsed as { lastSystemConfigDigest?: unknown }).lastSystemConfigDigest === 'string'
        ? (parsed as { lastSystemConfigDigest: string }).lastSystemConfigDigest
        : null
    const effectiveSystemConfigDigest = lastMirrorableSystemConfigDigest ?? legacySystemConfigDigest
    const lastSystemConfigUnitDigests =
      isStateObject &&
      isValidDigestRecord(
        (parsed as { lastSystemConfigUnitDigests?: unknown }).lastSystemConfigUnitDigests
      )
        ? ((parsed as CodexConfigSyncState).lastSystemConfigUnitDigests ?? null)
        : null
    if (
      effectiveSystemConfigDigest !== null &&
      SYSTEM_CONFIG_DIGEST_PATTERN.test(effectiveSystemConfigDigest)
    ) {
      return {
        status: 'valid',
        digest: effectiveSystemConfigDigest,
        unitDigests: lastSystemConfigUnitDigests,
        needsRewrite:
          hasLegacySystemConfig ||
          lastSystemConfigUnitDigests === null ||
          legacySystemConfigDigest !== null
      }
    }
    if (lastSystemConfig !== null) {
      return {
        status: 'legacy',
        systemConfig: lastSystemConfig
      }
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'invalid' }
  }
  return { status: 'invalid' }
}

function isValidDigestRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.entries(value).every(
    ([key, digest]) =>
      SYSTEM_CONFIG_DIGEST_PATTERN.test(key) &&
      typeof digest === 'string' &&
      SYSTEM_CONFIG_DIGEST_PATTERN.test(digest)
  )
}

export function writeLastSyncedMirrorableSystemCodexConfigDigest(
  mirrorableSystemConfig: string,
  unitDigests: Record<string, string>
): void {
  writeLastSyncedMirrorableSystemCodexConfigDigestValue(
    getSystemCodexConfigDigest(mirrorableSystemConfig),
    unitDigests
  )
}

export function writeLastSyncedMirrorableSystemCodexConfigDigestValue(
  digest: string,
  unitDigests: Record<string, string>
): void {
  if (!SYSTEM_CONFIG_DIGEST_PATTERN.test(digest)) {
    throw new Error('Invalid Codex config digest')
  }
  if (!isValidDigestRecord(unitDigests)) {
    throw new Error('Invalid Codex config unit digests')
  }
  writeConfigSyncState({
    lastMirrorableSystemConfigDigest: digest,
    lastSystemConfigUnitDigests: unitDigests
  })
}

export function writeLastSyncedMirrorableSystemCodexConfigDigestOnly(digest: string): void {
  if (!SYSTEM_CONFIG_DIGEST_PATTERN.test(digest)) {
    throw new Error('Invalid Codex config digest')
  }
  writeConfigSyncState({ lastMirrorableSystemConfigDigest: digest })
}

function writeConfigSyncState(state: {
  lastMirrorableSystemConfigDigest: string
  lastSystemConfigUnitDigests?: Record<string, string>
}): void {
  // Why: config.toml can contain provider credentials; a digest is enough to
  // detect user edits without persisting a second copy of the config.
  writeFileAtomically(getCodexConfigSyncStatePath(), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600
  })
}
