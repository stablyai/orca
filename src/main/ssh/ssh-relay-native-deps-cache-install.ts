/**
 * The deploy-side half of the shared native-deps cache: resolve this build's key, try to link an
 * existing entry, and publish a probe-verified tree afterwards.
 *
 * Both entry points answer with a value, never an exception. The cache is an optimization on a
 * path that must still connect a host with a read-only home, no `ln`, or an SSH server that drops
 * the channel — every one of those is a plain per-directory install, which is what the relay did
 * before this existed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SshConnection } from './ssh-connection'
import { RELAY_ARTIFACTS } from '../../shared/relay-artifacts'
import { execCommand } from './ssh-relay-deploy-helpers'
import { NATIVE_DEPS_COMMAND_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import {
  computeRelayNativeDepsCacheKey,
  supportsRelayNativeDepsCache,
  RELAY_NATIVE_DEPS_PATCH_ARTIFACT_PATTERN,
  type RelayNativeDepsCachePatchSource
} from './ssh-relay-native-deps-cache'
import {
  ensureRelayNativeDepsCacheCommand,
  promoteRelayNativeDepsCacheCommand,
  RELAY_NATIVE_CACHE_LINKED,
  RELAY_NATIVE_CACHE_PROMOTED,
  RELAY_NATIVE_CACHE_SEEDED,
  type RelayNativeDepsCachePaths
} from './ssh-relay-native-deps-cache-commands'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/**
 * `linked` — the relay directory now points at a complete shared entry and needs no install.
 * `private` — it owns (or is about to own) its own tree, which promotion may later publish.
 */
export type RelayNativeDepsCacheAttachment = {
  mode: 'linked' | 'private'
  key: string
}

export type RelayNativeDepsCacheContext = {
  hostPlatform: RemoteHostPlatform
  remoteHome: string
  relayDir: string
  platform: string
  localRelayDir: string
  deps: Readonly<Record<string, string>>
  signal?: AbortSignal
}

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string,
  signal?: AbortSignal
): Promise<string> {
  return execCommand(conn, command, {
    wrapCommand: host.commandDialect !== 'powershell',
    // Why the native-deps budget and not the default 30s: a seeding copy moves a whole
    // node_modules on the host's own disk, which is fast but not instant on a cold cache.
    timeoutMs: NATIVE_DEPS_COMMAND_TIMEOUT_MS,
    signal
  })
}

/**
 * Every shipped artifact that patches the installed native tree, read for hashing.
 *
 * Reading is best-effort by design: a patch this client cannot read must not silently drop out of
 * the key, so an unreadable one disables the cache rather than producing a key that claims the
 * patch was applied.
 */
export function readRelayNativeDepsPatchSources(
  localRelayDir: string
): RelayNativeDepsCachePatchSource[] | null {
  const sources: RelayNativeDepsCachePatchSource[] = []
  for (const artifact of RELAY_ARTIFACTS) {
    if (!RELAY_NATIVE_DEPS_PATCH_ARTIFACT_PATTERN.test(artifact.filename)) {
      continue
    }
    const path = join(localRelayDir, artifact.filename)
    try {
      if (!existsSync(path)) {
        continue
      }
      sources.push({ filename: artifact.filename, contents: readFileSync(path, 'utf-8') })
    } catch {
      return null
    }
  }
  return sources
}

/** This build's cache key, or null when it cannot be computed and the cache must stay off. */
export function resolveRelayNativeDepsCacheKey(context: {
  platform: string
  localRelayDir: string
  deps: Readonly<Record<string, string>>
}): string | null {
  const patchSources = readRelayNativeDepsPatchSources(context.localRelayDir)
  if (!patchSources) {
    return null
  }
  try {
    return computeRelayNativeDepsCacheKey({
      platform: context.platform,
      deps: context.deps,
      patchSources
    })
  } catch (err) {
    console.warn(
      `[ssh-relay] Native-deps cache key unavailable for ${context.platform}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return null
  }
}

/**
 * Link a complete entry, or leave the relay directory to install privately.
 *
 * Returns null when the cache is off for this host, which keeps the caller on the exact command
 * sequence it ran before the cache existed.
 */
export async function attachRelayNativeDepsCache(
  conn: SshConnection,
  context: RelayNativeDepsCacheContext
): Promise<RelayNativeDepsCacheAttachment | null> {
  if (!supportsRelayNativeDepsCache(context.hostPlatform)) {
    return null
  }
  const key = resolveRelayNativeDepsCacheKey(context)
  if (!key) {
    return null
  }
  const paths = cachePathsFor(context, key)
  try {
    const output = await execHostCommand(
      conn,
      context.hostPlatform,
      ensureRelayNativeDepsCacheCommand(paths, context.deps),
      context.signal
    )
    if (output.includes(RELAY_NATIVE_CACHE_LINKED)) {
      console.log(`[ssh-relay] Native deps linked from shared cache entry ${key}`)
      return { mode: 'linked', key }
    }
    if (output.includes(RELAY_NATIVE_CACHE_SEEDED)) {
      console.log(`[ssh-relay] Seeded native deps for ${key} from an existing install on this host`)
    }
    return { mode: 'private', key }
  } catch (err) {
    context.signal?.throwIfAborted()
    // Why still 'private' and not null: the relay directory owns nothing yet either way, and the
    // install that follows is identical. Promotion afterwards is separately best-effort.
    console.warn(
      `[ssh-relay] Native-deps cache probe for ${key} failed; installing per-directory: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { mode: 'private', key }
  }
}

/**
 * Publish a private tree the probe just loaded, and link the relay directory to it.
 *
 * Called only after `probeInstalledNativeDeps` reported both addons loadable on this host, so an
 * entry is never published on the strength of a successful `npm install` alone.
 */
export async function promoteRelayNativeDepsCache(
  conn: SshConnection,
  context: RelayNativeDepsCacheContext,
  key: string
): Promise<void> {
  try {
    const output = await execHostCommand(
      conn,
      context.hostPlatform,
      promoteRelayNativeDepsCacheCommand(cachePathsFor(context, key)),
      context.signal
    )
    console.log(
      output.includes(RELAY_NATIVE_CACHE_PROMOTED)
        ? `[ssh-relay] Published native deps as shared cache entry ${key}`
        : `[ssh-relay] Native deps stay per-directory; shared cache entry ${key} was not published`
    )
  } catch (err) {
    context.signal?.throwIfAborted()
    console.warn(
      `[ssh-relay] Could not publish native-deps cache entry ${key}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

function cachePathsFor(
  context: RelayNativeDepsCacheContext,
  key: string
): RelayNativeDepsCachePaths {
  return {
    host: context.hostPlatform,
    remoteHome: context.remoteHome,
    relayDir: context.relayDir,
    key
  }
}
