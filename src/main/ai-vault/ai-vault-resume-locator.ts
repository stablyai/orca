import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'

const LOCATOR_VERSION = 'v1'

function canonicalTranscriptPath(filePath: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? win32.normalize(filePath).replace(/\\/g, '/').toLowerCase()
    : posix.normalize(filePath)
}

function lengthDelimited(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`
}

/**
 * Builds the opaque selector echoed by Vault clients. The digest is only a
 * collision-resistant fresh-scan locator; launch authority remains host-private.
 */
export function createAiVaultResumeLocator(args: {
  executionHostId: ExecutionHostId
  agent: AiVaultAgent
  sessionId: string
  transcriptPath: string
  platform: NodeJS.Platform
}): string {
  const tuple = [
    LOCATOR_VERSION,
    args.executionHostId,
    args.agent,
    args.sessionId,
    canonicalTranscriptPath(args.transcriptPath, args.platform)
  ]
    .map(lengthDelimited)
    .join('')
  return createHash('sha256').update(tuple, 'utf8').digest('hex')
}
