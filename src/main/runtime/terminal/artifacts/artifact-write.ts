import { chmod, constants, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RuntimeTerminalFileGrants } from './file-grants'
import { MOBILE_FILE_READ_MAX_BYTES } from '../../files/file-preview-budget'
import { isMobileBinaryPath } from '../../files/mobile-file-kind'
import { isBinaryBuffer } from '../../../../shared/binary-buffer'
import { openLocalTerminalArtifactGrant } from './local-artifact-read'
import {
  assertTerminalArtifactContentUnchanged,
  assertTerminalFileGrantFresh,
  readFileHandleBufferBounded,
  terminalFileStatIdentity
} from './artifact-integrity'
import { statLocalTerminalArtifact } from './artifact-stat'

export async function writeTerminalArtifactFile(
  grants: Pick<RuntimeTerminalFileGrants, 'requireTerminalFileGrant' | 'refreshTerminalFileGrant'>,
  worktreeSelector: string,
  grantId: string,
  absolutePath: string,
  content: string,
  clientId?: string
): Promise<{ ok: true }> {
  if (Buffer.byteLength(content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  const { grant } = await grants.requireTerminalFileGrant(
    worktreeSelector,
    grantId,
    absolutePath,
    clientId
  )
  if (isMobileBinaryPath(grant.absolutePath)) {
    throw new Error('binary_file')
  }
  let originalMode: number | null = null
  const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
  try {
    const fileStats = await handle.stat()
    originalMode = fileStats.mode
    if (fileStats.isDirectory()) {
      throw new Error('Cannot write to a directory')
    }
    if (fileStats.size > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    assertTerminalFileGrantFresh(grant, fileStats)
    const buffer = await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1)
    assertTerminalArtifactContentUnchanged(grant, buffer)
    if (isBinaryBuffer(buffer)) {
      throw new Error('binary_file')
    }
  } finally {
    await handle.close()
  }
  const tempPath = join(
    dirname(grant.absolutePath),
    `.${basename(grant.absolutePath)}.${randomUUID()}.tmp`
  )
  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' })
    if (typeof originalMode === 'number') {
      await chmod(tempPath, originalMode & 0o7777)
    }
    const freshHandle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      assertTerminalFileGrantFresh(grant, await freshHandle.stat())
      assertTerminalArtifactContentUnchanged(
        grant,
        await readFileHandleBufferBounded(freshHandle, MOBILE_FILE_READ_MAX_BYTES + 1)
      )
    } finally {
      await freshHandle.close()
    }
    await rename(tempPath, grant.absolutePath)
    const committed = await statLocalTerminalArtifact(grant.absolutePath)
    grant.statIdentity = terminalFileStatIdentity(committed.stats)
    grant.contentDigest = committed.contentDigest
    grants.refreshTerminalFileGrant(grant)
    return { ok: true }
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}
