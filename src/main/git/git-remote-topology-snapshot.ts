import { captureGitSelectorEndpoints, type GitSelectorEndpoints } from './git-selector-endpoints'
import {
  parseGitRemoteFetchUrls,
  parseGitRemoteVerboseLine
} from '../../shared/git-remote-url-index'
import { readLocalGitConfigSignature } from '../github/local-git-config-signature'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import type { GitAdmissionTier } from './command-runner/git-exec-options'
import { gitExecFileAsync } from './runner'

export type GitRemoteTopologySnapshot = {
  selectorEndpoints?: Map<string, GitSelectorEndpoints>
  config: Map<string, string>
  localBranchOids: Map<string, string>
  remoteBranchOids: Map<string, string>
  remoteNames: string[]
  fetchUrls: Map<string, string>
  pushUrls: Map<string, string[]>
  upstreamRefs: Map<string, string>
}

type LocalGitOptions = { wslDistro?: string; admissionTier?: GitAdmissionTier }
type CachedSnapshot = {
  expiresAt: number
  configSignature?: string
  snapshot: GitRemoteTopologySnapshot
}

const SNAPSHOT_TTL_MS = 30_000
const SNAPSHOT_CACHE_MAX_ENTRIES = 512
const SNAPSHOT_MAX_REMOTES = 128
const SNAPSHOT_MAX_REFS = 4_096
const SNAPSHOT_MAX_URLS = 512
const snapshotCache = new Map<string, CachedSnapshot>()
const snapshotInFlight = new Map<string, Promise<GitRemoteTopologySnapshot>>()

function runtimeKey(connectionId?: string | null, options: LocalGitOptions = {}): string {
  return connectionId
    ? `ssh:${connectionId}:${getSshGitProviderGeneration(connectionId)}`
    : `local:${options.wslDistro ?? 'host'}`
}

function pruneSnapshotCache(now: number): void {
  for (const [key, entry] of snapshotCache) {
    if (entry.expiresAt <= now) {
      snapshotCache.delete(key)
    }
  }
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = snapshotCache.keys().next().value
    if (oldest === undefined) {
      return
    }
    snapshotCache.delete(oldest)
  }
}

export function normalizeGitConfigKey(key: string): string {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  return first === last
    ? key.toLowerCase()
    : key.slice(0, first).toLowerCase() + key.slice(first, last) + key.slice(last).toLowerCase()
}

function parseConfigSnapshot(stdout: string): Map<string, string> {
  const config = new Map<string, string>()
  for (const record of stdout.split('\0')) {
    const separator = record.indexOf('\n')
    if (separator !== -1) {
      config.set(normalizeGitConfigKey(record.slice(0, separator)), record.slice(separator + 1))
    }
  }
  return config
}

function parseRefSnapshot(
  stdout: string
): Pick<GitRemoteTopologySnapshot, 'localBranchOids' | 'remoteBranchOids' | 'upstreamRefs'> {
  const upstreamRefs = new Map<string, string>()
  const localBranchOids = new Map<string, string>()
  const remoteBranchOids = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [refName, oid, upstream] = line.split('\0')
    if (!refName || !oid) {
      continue
    }
    if (refName.startsWith('refs/heads/')) {
      localBranchOids.set(refName.slice('refs/heads/'.length), oid)
      if (upstream) {
        upstreamRefs.set(refName.slice('refs/heads/'.length), upstream)
      }
    } else if (refName.startsWith('refs/remotes/')) {
      remoteBranchOids.set(refName.slice('refs/remotes/'.length), oid)
    }
  }
  return { localBranchOids, remoteBranchOids, upstreamRefs }
}

async function probeSnapshot(
  repoPath: string,
  connectionId?: string | null,
  options: LocalGitOptions = {}
): Promise<GitRemoteTopologySnapshot> {
  const provider = connectionId ? getSshGitProvider(connectionId) : null
  if (connectionId && !provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  const runGit = async (args: string[]): Promise<{ stdout: string }> => {
    if (provider) {
      return provider.exec(args, repoPath)
    }
    return gitExecFileAsync(args, {
      cwd: repoPath,
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
    })
  }
  const [remoteResult, configResult, refResult] = await Promise.all([
    runGit(['remote', '-v']),
    runGit(['config', '--list', '-z']),
    runGit([
      'for-each-ref',
      `--count=${SNAPSHOT_MAX_REFS + 1}`,
      '--format=%(refname)%00%(objectname)%00%(upstream)',
      'refs/heads',
      'refs/remotes'
    ])
  ])
  const refs = parseRefSnapshot(refResult.stdout)
  if (refs.localBranchOids.size + refs.remoteBranchOids.size > SNAPSHOT_MAX_REFS) {
    throw new Error('Git remote topology has too many refs to resolve safely.')
  }
  const fetchUrls = parseGitRemoteFetchUrls(remoteResult.stdout)
  const pushUrls = new Map<string, string[]>()
  for (const line of remoteResult.stdout.split(/\r?\n/)) {
    const entry = parseGitRemoteVerboseLine(line)
    if (entry?.direction === 'push') {
      pushUrls.set(entry.name, [...(pushUrls.get(entry.name) ?? []), entry.url])
    }
  }
  if (
    fetchUrls.size + [...pushUrls.values()].reduce((sum, urls) => sum + urls.length, 0) >
    SNAPSHOT_MAX_URLS
  ) {
    throw new Error('Git remote topology has too many URLs to resolve safely.')
  }
  const remoteNames = [...new Set([...fetchUrls.keys(), ...pushUrls.keys()])]
  if (remoteNames.length > SNAPSHOT_MAX_REMOTES) {
    throw new Error('Git remote topology has too many remotes to resolve safely.')
  }
  const config = parseConfigSnapshot(configResult.stdout)
  const selectorEndpoints = await captureGitSelectorEndpoints(
    config,
    remoteNames,
    runGit,
    SNAPSHOT_MAX_URLS -
      fetchUrls.size -
      [...pushUrls.values()].reduce((sum, urls) => sum + urls.length, 0)
  )
  return {
    config,
    selectorEndpoints,
    ...refs,
    remoteNames,
    fetchUrls,
    pushUrls
  }
}

async function loadSnapshot(
  key: string,
  repoPath: string,
  connectionId?: string | null,
  options: LocalGitOptions = {},
  ownsProbe: () => boolean = () => true,
  branchName?: string
): Promise<GitRemoteTopologySnapshot> {
  const now = Date.now()
  pruneSnapshotCache(now)
  const cached = snapshotCache.get(key)
  if (
    cached &&
    cached.expiresAt > now &&
    (!branchName || cached.snapshot.localBranchOids.has(branchName))
  ) {
    if (!cached.configSignature) {
      return cached.snapshot
    }
    const currentSignature = await readLocalGitConfigSignature({
      repoPath,
      connectionId: connectionId ?? null,
      ...options
    })
    if (currentSignature === cached.configSignature) {
      return cached.snapshot
    }
    snapshotCache.delete(key)
  }
  const startingSignature = await readLocalGitConfigSignature({
    repoPath,
    connectionId: connectionId ?? null,
    ...options
  })
  const snapshot = await probeSnapshot(repoPath, connectionId, options)
  const endingSignature = await readLocalGitConfigSignature({
    repoPath,
    connectionId: connectionId ?? null,
    ...options
  })
  if (startingSignature === endingSignature && ownsProbe()) {
    snapshotCache.set(key, {
      snapshot,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      ...(endingSignature ? { configSignature: endingSignature } : {})
    })
    pruneSnapshotCache(Date.now())
  }
  return snapshot
}

export async function getGitRemoteTopologySnapshot(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitOptions
  branchName?: string
}): Promise<GitRemoteTopologySnapshot> {
  const key = [runtimeKey(args.connectionId, args.localGitOptions), args.repoPath].join('\0')
  const inFlight = snapshotInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const probe = loadSnapshot(
    key,
    args.repoPath,
    args.connectionId,
    args.localGitOptions,
    () => snapshotInFlight.get(key) === probe,
    args.branchName
  )
  snapshotInFlight.set(key, probe)
  try {
    return await probe
  } finally {
    if (snapshotInFlight.get(key) === probe) {
      snapshotInFlight.delete(key)
    }
  }
}

/** @internal */
export function _resetGitRemoteTopologySnapshotCache(): void {
  snapshotCache.clear()
  snapshotInFlight.clear()
}
