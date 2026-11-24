import { resolve } from 'node:path'
import { readGitBaselineSources } from '../../runtime-verification/daemon-lifecycle/git-baseline-sources.mjs'
import { DAEMON_PROTOCOL_SOURCE_PATH, parseDaemonProtocolFacts } from './daemon-protocol-facts.mjs'

export function readDaemonProtocolRevisionFacts(repoRoot, ref) {
  const sources = readGitBaselineSources(
    repoRoot,
    ref,
    new Map([[DAEMON_PROTOCOL_SOURCE_PATH, `${ref}:src/main/daemon/daemon-protocol-version.ts`]])
  )
  return parseDaemonProtocolFacts(
    sources.get(resolve(repoRoot, DAEMON_PROTOCOL_SOURCE_PATH)).contents,
    `${ref}:${DAEMON_PROTOCOL_SOURCE_PATH}`
  )
}
