import type { SshRelayDigest, SshRelayRuntimeTupleId } from './ssh-relay-runtime-identity'

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/
const RC_TAG = /^v(\d+\.\d+\.\d+-rc\.\d+)$/
const PERF_TAG = /^v(\d+\.\d+\.\d+-rc\.\d+\.perf)$/
const CONTENT_ID = /^sha256:([0-9a-f]{64})$/

export type SshRelayReleaseIdentity = {
  tag: string
  version: string
  channel: 'stable' | 'rc' | 'perf'
}

export function parseSshRelayReleaseTag(tag: string): SshRelayReleaseIdentity {
  for (const [pattern, channel] of [
    [STABLE_TAG, 'stable'],
    [RC_TAG, 'rc'],
    [PERF_TAG, 'perf']
  ] as const) {
    const match = pattern.exec(tag)
    if (match) {
      return { tag, version: match[1], channel }
    }
  }
  throw new Error(`Unsupported SSH relay release tag: ${tag}`)
}

export function sshRelayRuntimeArchiveName(
  tupleId: SshRelayRuntimeTupleId,
  contentId: SshRelayDigest
): string {
  const match = CONTENT_ID.exec(contentId)
  if (!match) {
    throw new Error(`Invalid SSH relay runtime content identity: ${contentId}`)
  }
  const extension = tupleId.startsWith('win32-') ? 'zip' : 'tar.br'
  return `orca-ssh-relay-runtime-v1-${tupleId}-${match[1]}.${extension}`
}

export function sshRelayRuntimeDownloadUrl(tag: string, archiveName: string): string {
  parseSshRelayReleaseTag(tag)
  if (!/^orca-ssh-relay-runtime-v1-[A-Za-z0-9.-]+\.(?:tar\.br|zip)$/.test(archiveName)) {
    throw new Error(`Invalid SSH relay runtime archive name: ${archiveName}`)
  }
  return `https://github.com/stablyai/orca/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(archiveName)}`
}
