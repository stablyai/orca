// An older Orca sweeps this store's root by its own claims, which never include uploads saved here.
// A second hard link outside that root keeps their bytes, and puts back any file it removed.

import { link, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'

/** A sibling of the store root, so no older sweep of that root ever visits it. */
export function agentSessionAttachmentKeptRoot(storeRoot: string): string {
  return `${storeRoot}-kept`
}

/** Links each committed file of one upload into the kept root, once, right after it is saved. */
export async function keepAgentSessionAttachmentUpload(
  storeRoot: string,
  uploadId: string
): Promise<void> {
  await keepMissingAgentSessionAttachmentFiles(
    storeRoot,
    uploadId,
    await entries(join(storeRoot, uploadId)),
    []
  )
}

export async function listKeptAgentSessionAttachments(storeRoot: string): Promise<Set<string>> {
  return new Set(await entries(agentSessionAttachmentKeptRoot(storeRoot)))
}

/**
 * Puts back every kept file missing from an upload's folder; returns the folder's entries after and
 * the kept files. A file, not its folder, says what is there: an older sweep stopped partway
 * leaves the folder behind empty.
 */
export async function restoreKeptAgentSessionAttachment(
  storeRoot: string,
  uploadId: string,
  present: readonly string[]
): Promise<{ present: string[]; kept: string[] }> {
  const keptDir = join(agentSessionAttachmentKeptRoot(storeRoot), uploadId)
  const kept = await entries(keptDir)
  if (kept.length === 0) {
    await forgetKeptAgentSessionAttachment(storeRoot, uploadId)
  }
  const missing = kept.filter((name) => !present.includes(name))
  if (missing.length > 0) {
    await linkAll(keptDir, join(storeRoot, uploadId), missing)
  }
  return { present: [...present, ...missing], kept }
}

/** Links an upload's committed files the kept root lacks; with all of them kept, does nothing. */
export async function keepMissingAgentSessionAttachmentFiles(
  storeRoot: string,
  uploadId: string,
  present: readonly string[],
  kept: readonly string[]
): Promise<void> {
  const missing = present.filter(
    (name) => name !== AGENT_SESSION_ATTACHMENT_PART_FILE && !kept.includes(name)
  )
  if (missing.length > 0) {
    await linkAll(
      join(storeRoot, uploadId),
      join(agentSessionAttachmentKeptRoot(storeRoot), uploadId),
      missing
    )
  }
}

/** Best effort: a leftover kept folder is put back and swept again later. */
export async function forgetKeptAgentSessionAttachment(
  storeRoot: string,
  uploadId: string
): Promise<void> {
  await rm(join(agentSessionAttachmentKeptRoot(storeRoot), uploadId), {
    recursive: true,
    force: true
  }).catch(() => {})
}

async function linkAll(from: string, to: string, files: readonly string[]): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const name of files) {
    try {
      await link(join(from, name), join(to, name))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}
