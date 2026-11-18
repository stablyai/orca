import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { BundledSkillObserved } from '../../../shared/skills/bundled/bundled-skill-plan'
import { isOsMetadataSkillEntryName } from '../package-archive/skill-package-identity'
import type { BundledSkillSource } from './bundled-skill-sources'
import { bundledSkillTreeSignature } from './bundled-skill-tree-signature'
import { isBundledSkillFileStage } from './bundled-skill-folder-swap'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'

export type BundledSkillFolderClass = 'absent' | 'current' | 'released' | 'edited' | 'other'

export type ClassifiedBundledSkillPath = {
  /** Decided by SKILL.md alone: other entries (e.g. Codex's agents/openai.yaml) are the user's and survive an update. */
  folderClass: BundledSkillFolderClass
  /** Whether the whole folder is Orca's to delete or retire: current/released only when SKILL.md is its only entry. */
  wholeFolderClass: BundledSkillFolderClass
  observed: BundledSkillObserved
}

const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 64 * 1024
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u
const FRONTMATTER_NAME = /^name:[ \t]*(.*)$/mu

/** sha256 of LF-normalised text, so a pre-#8624 CRLF clone still matches its release. */
export function bundledSkillTextDigest(bytes: Uint8Array): string {
  let normalized: Uint8Array = bytes
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    normalized = Buffer.from(text.replace(/\r\n?/gu, '\n'), 'utf8')
  } catch {
    // Not UTF-8, so it matches no release; hash the raw bytes.
  }
  return createHash('sha256').update(normalized).digest('hex')
}

function frontmatterName(bytes: Buffer): string | null {
  const frontmatter = FRONTMATTER.exec(bytes.toString('utf8'))?.[1]
  const value = frontmatter ? FRONTMATTER_NAME.exec(frontmatter)?.[1]?.trim() : null
  if (!value) {
    return null
  }
  const quote = value[0]
  return (quote === '"' || quote === "'") && value.endsWith(quote)
    ? value.slice(1, -1).trim() || null
    : value
}

async function observeTree(
  filesystem: BundledSkillFilesystem,
  path: string,
  observed: Extract<BundledSkillObserved, { kind: 'file' | 'folder' }>,
  includeTreeDigest: boolean
): Promise<BundledSkillObserved> {
  if (!includeTreeDigest) {
    return observed
  }
  try {
    return { ...observed, treeDigest: await bundledSkillTreeSignature(filesystem, path) }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** Planning and execution share this observation shape so race checks compare like with like. */
export async function classifyBundledSkillPath(
  filesystem: BundledSkillFilesystem,
  path: string,
  source: BundledSkillSource,
  currentDigest: string,
  includeTreeDigest = false
): Promise<ClassifiedBundledSkillPath> {
  const stat = await filesystem.stat(path)
  if (!stat) {
    return classified('other', { kind: 'unreadable' })
  }
  if (stat.kind === 'missing') {
    return classified('absent', { kind: 'absent' })
  }
  if (stat.kind === 'symlink') {
    const target = await filesystem.readLink(path)
    return classified('other', target === null ? { kind: 'unreadable' } : { kind: 'link', target })
  }
  if (stat.kind !== 'directory') {
    return classified(
      'other',
      await observeTree(
        filesystem,
        path,
        { kind: 'file', mtimeMs: stat.mtimeMs },
        includeTreeDigest
      )
    )
  }
  const listing = await filesystem.listEntries(path)
  if (!listing) {
    return classified('other', { kind: 'unreadable' })
  }
  // Only a plain file is OS-authored or Orca's own update stage; a folder or link wearing the name is content.
  const entries = listing
    .filter(
      (entry) =>
        !(
          entry.kind === 'file' &&
          (isOsMetadataSkillEntryName(entry.name) || isBundledSkillFileStage(entry.name))
        )
    )
    .map((entry) => `${entry.name}:${entry.kind}`)
    .sort()
  const bytes = entries.includes(`${SKILL_FILE}:file`)
    ? await filesystem.readFile(join(path, SKILL_FILE), MAX_SKILL_BYTES)
    : null
  const skillDigest = bytes ? bundledSkillTextDigest(bytes) : null
  const observed: BundledSkillObserved = { kind: 'folder', entries, skillDigest }
  const fileClass =
    skillDigest === null
      ? null
      : skillDigest === currentDigest
        ? 'current'
        : source.releasedDigests.includes(skillDigest)
          ? 'released'
          : null
  if (fileClass && entries.length === 1) {
    return classified(fileClass, observed)
  }
  const unshipped =
    bytes && [source.name, ...(source.aliases ?? [])].includes(frontmatterName(bytes) ?? '')
      ? 'edited'
      : 'other'
  return {
    folderClass: fileClass ?? unshipped,
    wholeFolderClass: unshipped,
    observed: await observeTree(filesystem, path, observed, includeTreeDigest)
  }
}

function classified(
  folderClass: BundledSkillFolderClass,
  observed: BundledSkillObserved
): ClassifiedBundledSkillPath {
  return { folderClass, wholeFolderClass: folderClass, observed }
}
