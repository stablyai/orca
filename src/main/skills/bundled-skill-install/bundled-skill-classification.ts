import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type {
  BundledSkillObserved,
  BundledSkillOp
} from '../../../shared/skills/bundled/bundled-skill-plan'
import { isOsMetadataSkillEntryName } from '../package-archive/skill-package-identity'
import type { BundledSkillSource } from './bundled-skill-sources'
import { bundledSkillTreeSignature } from './bundled-skill-tree-signature'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'

/** `current`/`released`: the folder holds only Orca's SKILL.md, so it is safe to replace or delete. */
export type BundledSkillFolderClass = 'absent' | 'current' | 'released' | 'edited' | 'other'

/** Planning also tells another Orca build's copy apart from a user edit. */
export type PlannedFolderClass = BundledSkillFolderClass | 'other-build'

export const ORCA_COPY_CLASSES = new Set<PlannedFolderClass>([
  'current',
  'released',
  'edited',
  'other-build'
])

export type ClassifiedBundledSkillPath = {
  folderClass: BundledSkillFolderClass
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
    return { folderClass: 'other', observed: { kind: 'unreadable' } }
  }
  if (stat.kind === 'missing') {
    return { folderClass: 'absent', observed: { kind: 'absent' } }
  }
  if (stat.kind === 'symlink') {
    const target = await filesystem.readLink(path)
    return {
      folderClass: 'other',
      observed: target === null ? { kind: 'unreadable' } : { kind: 'link', target }
    }
  }
  if (stat.kind !== 'directory') {
    return {
      folderClass: 'other',
      observed: await observeTree(
        filesystem,
        path,
        { kind: 'file', mtimeMs: stat.mtimeMs },
        includeTreeDigest
      )
    }
  }
  const listing = await filesystem.listEntries(path)
  if (!listing) {
    return { folderClass: 'other', observed: { kind: 'unreadable' } }
  }
  // Only a plain file is OS-authored; a folder or link wearing the name is content.
  const entries = listing
    .filter((entry) => !(entry.kind === 'file' && isOsMetadataSkillEntryName(entry.name)))
    .map((entry) => `${entry.name}:${entry.kind}`)
    .sort()
  const bytes = entries.includes(`${SKILL_FILE}:file`)
    ? await filesystem.readFile(join(path, SKILL_FILE), MAX_SKILL_BYTES)
    : null
  const skillDigest = bytes ? bundledSkillTextDigest(bytes) : null
  const observed: BundledSkillObserved = { kind: 'folder', entries, skillDigest }
  if (entries.length === 1 && skillDigest !== null) {
    if (skillDigest === currentDigest) {
      return { folderClass: 'current', observed }
    }
    if (source.releasedDigests.includes(skillDigest)) {
      return { folderClass: 'released', observed }
    }
  }
  return {
    folderClass:
      bytes && [source.name, ...(source.aliases ?? [])].includes(frontmatterName(bytes) ?? '')
        ? 'edited'
        : 'other',
    observed: await observeTree(filesystem, path, observed, includeTreeDigest)
  }
}

/** Freshness judges only the SKILL.md Orca ships: this build's exact text beside an agent's files is current. */
export function bundledSkillFreshnessClass(
  classified: ClassifiedBundledSkillPath,
  currentDigest: string
): PlannedFolderClass {
  const { folderClass, observed } = classified
  return folderClass === 'edited' &&
    observed.kind === 'folder' &&
    observed.skillDigest === currentDigest
    ? 'current'
    : folderClass
}

/** Kept only because its SKILL.md is judged alone; a link takes its shared copy's answer. */
export function keptBesideAgentFiles(
  op: Pick<BundledSkillOp, 'kind' | 'reason' | 'observed'>,
  linkedBeside?: boolean
): boolean {
  if (op.observed.kind === 'link') {
    return Boolean(linkedBeside)
  }
  return (
    (op.kind === 'keep' || op.reason === 'other-build') &&
    op.observed.kind === 'folder' &&
    op.observed.entries.length > 1
  )
}
