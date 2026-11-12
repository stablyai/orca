import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  AGENT_CONFIG_FILE_KINDS,
  AGENT_CONFIG_LEGACY_KINDS,
  AGENT_CONFIG_LIMITS,
  AGENT_CONFIG_SELF_PATH,
  AgentConfigItemKind,
  AgentConfigItemScope,
  AgentConfigSyncPlanParams,
  agentConfigItemKey,
  isSkillKind,
  type AgentConfigItemPayload,
  type AgentConfigPlanOutcome,
  type AgentConfigPutOutcome,
  type AgentConfigSyncPlanResult,
  type AgentConfigSyncPutParams,
  type AgentConfigSyncPutResult
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { excludeFromGit, ledgerPath, readLedger, writeLedger } from './host-agent-config-ledger'
import { agentConfigDigest, type AgentConfigDigestEntry } from '../agent-config-digest'
import { agentConfigItemPath, agentConfigRoot, type AgentConfigHomes } from '../agent-config-roots'

export type HostAgentConfigSyncDeps = {
  homes: AgentConfigHomes
  /** The host workspace's checkout (ORCA_WORKSPACE_PATH); project items go there. */
  projectPath: string | null
  /** Folder for this host's per-computer ledgers. */
  ledgerDir: string
}

type ItemId = { scope: AgentConfigItemScope; kind: AgentConfigItemKind; name: string }

function parseKey(key: string): ItemId | null {
  const [scope, kind, ...rest] = key.split(':')
  const parsedScope = AgentConfigItemScope.safeParse(scope)
  const parsedKind = AgentConfigItemKind.safeParse(kind)
  const name = rest.join(':')
  if (!parsedScope.success || !parsedKind.success || !name) {
    return null
  }
  // Same checks as a fresh request, so a tampered ledger can't name a path outside the roots.
  const checked = AgentConfigSyncPlanParams.safeParse({
    syncer: 'ledger',
    items: [{ scope, kind, name, digest: '0'.repeat(64) }]
  })
  return checked.success ? { scope: parsedScope.data, kind: parsedKind.data, name } : null
}

function destinationOf(item: ItemId, deps: HostAgentConfigSyncDeps): string | null {
  const root = agentConfigRoot(item.kind, item.scope, deps.homes, deps.projectPath)
  return root ? agentConfigItemPath(root, item.kind, item.name) : null
}

/** Digest of what is on disk now: null when absent, 'foreign' for anything not a plain copy. */
async function digestOnDisk(path: string, kind: AgentConfigItemKind): Promise<string | null> {
  const info = await lstat(path).catch(() => null)
  if (!info) {
    return null
  }
  if (info.isSymbolicLink()) {
    return 'foreign'
  }
  if (AGENT_CONFIG_FILE_KINDS.has(kind)) {
    if (!info.isFile()) {
      return 'foreign'
    }
    return agentConfigDigest([
      { path: AGENT_CONFIG_SELF_PATH, executable: false, bytes: await readFile(path) }
    ])
  }
  if (!info.isDirectory()) {
    return 'foreign'
  }
  const entries: AgentConfigDigestEntry[] = []
  const visit = async (dir: string, prefix: string): Promise<boolean> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!(await visit(full, rel))) {
          return false
        }
      } else if (entry.isFile()) {
        const stat = await lstat(full)
        entries.push({
          path: rel,
          executable: (stat.mode & 0o111) !== 0,
          bytes: await readFile(full)
        })
        if (entries.length > AGENT_CONFIG_LIMITS.filesPerItem * 2) {
          return false
        }
      } else {
        return false
      }
    }
    return true
  }
  try {
    return (await visit(path, '')) ? agentConfigDigest(entries) : 'foreign'
  } catch {
    return 'foreign'
  }
}

/** Decides each item before any bytes move, and removes what this computer stopped sending. */
export async function planHostAgentConfigSync(
  params: AgentConfigSyncPlanParams,
  deps: HostAgentConfigSyncDeps
): Promise<AgentConfigSyncPlanResult> {
  const path = ledgerPath(deps.ledgerDir, params.syncer)
  const ledger = await readLedger(path)
  const items: Record<string, AgentConfigPlanOutcome> = {}
  const wanted = new Set<string>()
  for (const item of params.items) {
    const key = agentConfigItemKey(item.scope, item.kind, item.name)
    wanted.add(key)
    const dest = destinationOf(item, deps)
    if (!dest) {
      items[key] = 'no-project'
      continue
    }
    const onDisk = await digestOnDisk(dest, item.kind)
    if (onDisk === null) {
      items[key] = 'needed'
    } else if (onDisk === item.digest) {
      items[key] = 'unchanged'
      ledger.items[key] = item.digest
    } else if (ledger.items[key] === onDisk) {
      items[key] = 'needed'
    } else {
      // Made or edited in the sandbox: it's the user's now.
      items[key] = 'kept-host'
      delete ledger.items[key]
    }
  }
  let removed = 0
  // Only the kinds this call manages are pruned: an older desktop that knows only the first five
  // never removes subagents or memory a newer one wrote.
  const managed: ReadonlySet<string> = new Set(params.kinds ?? AGENT_CONFIG_LEGACY_KINDS)
  for (const [key, digest] of Object.entries(ledger.items)) {
    if (wanted.has(key) || !managed.has(key.split(':')[1] ?? '')) {
      continue
    }
    delete ledger.items[key]
    const id = parseKey(key)
    const dest = id ? destinationOf(id, deps) : null
    // Only an untouched copy goes; an edited one stays as the user's.
    if (id && dest && (await digestOnDisk(dest, id.kind)) === digest) {
      await rm(dest, { recursive: true, force: true })
      removed += 1
    }
  }
  await writeLedger(path, ledger)
  return { items, removed }
}

function decodeFiles(item: AgentConfigItemPayload): AgentConfigDigestEntry[] | null {
  const isFileKind = AGENT_CONFIG_FILE_KINDS.has(item.kind)
  if (isFileKind && (item.files.length !== 1 || item.files[0].path !== AGENT_CONFIG_SELF_PATH)) {
    return null
  }
  const paths = new Set<string>()
  const entries: AgentConfigDigestEntry[] = []
  let total = 0
  for (const file of item.files) {
    if ((!isFileKind && file.path === AGENT_CONFIG_SELF_PATH) || paths.has(file.path)) {
      return null
    }
    paths.add(file.path)
    const bytes = Buffer.from(file.base64, 'base64')
    total += bytes.length
    if (bytes.length > AGENT_CONFIG_LIMITS.fileBytes || total > AGENT_CONFIG_LIMITS.itemBytes) {
      return null
    }
    entries.push({ path: file.path, executable: !isFileKind && file.executable, bytes })
  }
  if (!isFileKind && !paths.has('SKILL.md')) {
    return null
  }
  return agentConfigDigest(entries) === item.digest ? entries : null
}

async function writeItem(
  dest: string,
  kind: AgentConfigItemKind,
  files: AgentConfigDigestEntry[]
): Promise<void> {
  const parent = dirname(dest)
  await mkdir(parent, { recursive: true })
  const tag = randomBytes(6).toString('hex')
  if (AGENT_CONFIG_FILE_KINDS.has(kind)) {
    writeFileAtomically(dest, files[0].bytes, { mode: 0o644 })
    return
  }
  // Built beside the target, then swapped in, so an agent never reads half a skill.
  const staged = join(parent, `.orca-sync-${tag}`)
  try {
    for (const file of files) {
      const target = resolve(staged, file.path)
      if (isAbsolute(file.path) || !target.startsWith(`${staged}/`)) {
        throw new Error('Path escapes the skill folder.')
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.bytes, { mode: file.executable ? 0o755 : 0o644 })
    }
    const old = join(parent, `.orca-sync-old-${tag}`)
    const existed = await lstat(dest).then(
      () => true,
      () => false
    )
    if (existed) {
      await rename(dest, old)
    }
    await rename(staged, dest)
    if (existed) {
      await rm(old, { recursive: true, force: true })
    }
  } finally {
    await rm(staged, { recursive: true, force: true })
  }
}

/** Writes items the plan asked for. Rechecks ownership, so a file edited since the plan stays. */
export async function putHostAgentConfig(
  params: AgentConfigSyncPutParams,
  deps: HostAgentConfigSyncDeps
): Promise<AgentConfigSyncPutResult> {
  const path = ledgerPath(deps.ledgerDir, params.syncer)
  const ledger = await readLedger(path)
  const items: Record<string, AgentConfigPutOutcome> = {}
  for (const item of params.items) {
    const key = agentConfigItemKey(item.scope, item.kind, item.name)
    const id = parseKey(key)
    const files = id ? decodeFiles(item) : null
    if (!id || !files) {
      items[key] = 'invalid'
      continue
    }
    const dest = destinationOf(id, deps)
    if (!dest) {
      items[key] = 'no-project'
      continue
    }
    try {
      const onDisk = await digestOnDisk(dest, id.kind)
      if (onDisk !== null && onDisk !== item.digest && ledger.items[key] !== onDisk) {
        items[key] = 'kept-host'
        continue
      }
      if (onDisk !== item.digest) {
        await writeItem(dest, id.kind, files)
      }
      if (id.scope === 'project' && deps.projectPath) {
        await excludeFromGit(deps.projectPath, dest, isSkillKind(id.kind))
      }
      ledger.items[key] = item.digest
      items[key] = onDisk === null ? 'added' : 'updated'
    } catch {
      items[key] = 'failed'
    }
  }
  await writeLedger(path, ledger)
  const counts = Object.values(items).reduce<Record<string, number>>((acc, outcome) => {
    acc[outcome] = (acc[outcome] ?? 0) + 1
    return acc
  }, {})
  console.info(
    `[agent-config-sync] ${Object.entries(counts)
      .map(([outcome, n]) => `${outcome}=${n}`)
      .join(',')}`
  )
  return { items }
}
