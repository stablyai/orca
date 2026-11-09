// "Move to this computer" steps: pack in the VM over orcad, download, import the branch, apply
// changes, install sessions. The IPC flow is cloud-transfer.ts.
// "Move to this computer" for Orca Cloud workspaces. Everything travels over the workspace's E2EE
// orcad connection (terminal + file RPCs); the control plane never sees repository content.
// prepare: pack in the VM → download in chunks → fetch the branch into the local repo.
// finish (after the window created the local worktree): apply staged/unstaged diffs, untracked
// files, and install Claude/Codex sessions remapped to the new path so native resume works.
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import {
  CLOUD_TRANSFER_DIR,
  CLOUD_TRANSFER_LOG,
  CLOUD_TRANSFER_MAX_BYTES,
  CLOUD_TRANSFER_SCRIPT,
  CloudTransferResultSchema,
  CLOUD_TRANSFER_RESULT,
  cloudTransferPackScript,
  pickTransferBranchName,
  remapSessionTranscript,
  type CloudTransferManifest
} from '../../shared/hosted-sandbox/cloud-transfer-pack'
import type { RuntimeCall } from './hosted-agent-auto-resume'

const run = promisify(execFile)
const CHUNK_BYTES = 512 * 1024
const PACK_TIMEOUT_MS = 10 * 60_000

export type Prepared = {
  dir: string
  manifest: CloudTransferManifest
  repoPath: string
  workspaceId: string
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

export async function fileSize(path: string): Promise<number> {
  return stat(path)
    .then((s) => s.size)
    .catch(() => 0)
}

export type WorktreeRow = { id?: unknown; path?: unknown }

/** The orcad-side worktree for this workspace: its id, else the VM project root, else the only one. */
export function pickCloudWorktree(
  rows: WorktreeRow[],
  workspaceId: string,
  projectRoot: string | null
): { id: string; path: string } | null {
  const valid = rows.filter(
    (row): row is { id: string; path: string } =>
      typeof row.id === 'string' && typeof row.path === 'string'
  )
  return (
    valid.find((row) => row.id === workspaceId || row.id.endsWith(`::${workspaceId}`)) ??
    valid.find((row) => projectRoot !== null && row.path === projectRoot) ??
    (valid.length === 1 ? valid[0]! : null)
  )
}

/**
 * Runs one shell line in the cloud worktree through a background orcad terminal and waits for it
 * to exit. Scripts travel inside the command (base64), so no file-write RPC is needed.
 */
async function runInCloud(
  call: RuntimeCall,
  worktree: string,
  commandLine: string,
  title: string
): Promise<void> {
  const created = (await call('terminal.create', {
    worktree,
    command: commandLine,
    title,
    presentation: 'background',
    focus: false,
    activate: false
  })) as { terminal?: { handle?: string } | string }
  const handle = typeof created.terminal === 'string' ? created.terminal : created.terminal?.handle
  if (!handle) {
    throw new Error('Could not run a command in the cloud workspace.')
  }
  try {
    await call('terminal.wait', { terminal: handle, for: 'exit', timeoutMs: PACK_TIMEOUT_MS })
  } finally {
    await call('terminal.close', { terminal: handle }).catch(() => undefined)
  }
}

/** Packs the worktree in the VM; returns its manifest and the archive size (checked before any download). */
export async function packInCloud(
  call: RuntimeCall,
  worktree: string
): Promise<{ manifest: CloudTransferManifest; archiveBytes: number }> {
  const script = Buffer.from(cloudTransferPackScript(), 'utf8').toString('base64')
  await runInCloud(
    call,
    worktree,
    `mkdir -p ${CLOUD_TRANSFER_DIR} && printf %s ${script} | base64 -d >${CLOUD_TRANSFER_SCRIPT} && exec bash ${CLOUD_TRANSFER_SCRIPT} >${CLOUD_TRANSFER_LOG} 2>&1`,
    'Moving to this computer'
  )
  const raw = await readCloudText(call, worktree, CLOUD_TRANSFER_RESULT).catch(() => '')
  const parsed = raw ? CloudTransferResultSchema.safeParse(JSON.parse(raw)) : null
  if (!parsed?.success) {
    // Only the log's tail matters for the error (git can be chatty).
    const log = await readCloudTail(call, worktree, CLOUD_TRANSFER_LOG).catch(() => '')
    throw new Error(
      `Packing the cloud workspace failed: ${log.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`
    )
  }
  if (parsed.data.archiveBytes > CLOUD_TRANSFER_MAX_BYTES) {
    throw new Error('This workspace is too large to move in one go.')
  }
  return parsed.data
}

/** The last ≤8 KB of a cloud file. */
async function readCloudTail(
  call: RuntimeCall,
  worktree: string,
  relativePath: string
): Promise<string> {
  const stat = (await call('files.stat', { worktree, relativePath })) as { size?: number }
  const offset = Math.max(0, (stat.size ?? 0) - 8192)
  const page = (await call('files.readChunk', {
    worktree,
    relativePath,
    offset,
    length: 8192
  })) as {
    contentBase64: string
  }
  return Buffer.from(page.contentBase64, 'base64').toString('utf8')
}

/** Removes the scratch directory in the VM (best effort). */
export function cleanUpCloud(call: RuntimeCall, worktree: string): Promise<void> {
  return runInCloud(
    call,
    worktree,
    `exec rm -rf ${CLOUD_TRANSFER_DIR}`,
    'Moving to this computer'
  ).catch(() => undefined)
}

async function readCloudText(
  call: RuntimeCall,
  worktree: string,
  relativePath: string
): Promise<string> {
  const page = (await call('files.readChunk', {
    worktree,
    relativePath,
    offset: 0,
    length: CHUNK_BYTES
  })) as {
    contentBase64: string
  }
  return Buffer.from(page.contentBase64, 'base64').toString('utf8')
}

/** Pages a cloud file to disk; returns bytes written. */
export async function downloadCloudFile(
  call: RuntimeCall,
  worktree: string,
  relativePath: string,
  destination: string,
  onProgress: (bytes: number) => void
): Promise<number> {
  const out = createWriteStream(destination)
  let offset = 0
  try {
    for (;;) {
      const page = (await call('files.readChunk', {
        worktree,
        relativePath,
        offset,
        length: CHUNK_BYTES
      })) as {
        contentBase64: string
        bytesRead: number
        eof: boolean
      }
      const bytes = Buffer.from(page.contentBase64, 'base64')
      if (!out.write(bytes)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      }
      offset += bytes.byteLength
      onProgress(offset)
      if (offset > CLOUD_TRANSFER_MAX_BYTES) {
        throw new Error('This workspace is too large to move in one go.')
      }
      if (page.eof || page.bytesRead === 0) {
        return offset
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
}

async function branchExists(repoPath: string, name: string): Promise<boolean> {
  return git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(
    () => true,
    () => false
  )
}

/** Fetches the bundle's HEAD into a free local branch; reuses the cloud name when it is free or already identical. */
export async function importBundle(
  repoPath: string,
  bundlePath: string,
  manifest: CloudTransferManifest
): Promise<string> {
  const taken = new Set<string>()
  for (const line of (
    await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  ).split('\n')) {
    if (line) {
      taken.add(line)
    }
  }
  // A branch already checked out in a local worktree (e.g. moved before) can't open a second one.
  const checkedOut = new Set(
    (await git(repoPath, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('branch refs/heads/'))
      .map((line) => line.slice('branch refs/heads/'.length))
  )
  if (
    manifest.branch &&
    manifest.head &&
    taken.has(manifest.branch) &&
    !checkedOut.has(manifest.branch)
  ) {
    const local = await git(repoPath, ['rev-parse', `refs/heads/${manifest.branch}`])
    if (local === manifest.head) {
      return manifest.branch
    }
  }
  const name = pickTransferBranchName(
    manifest.branch,
    (candidate) => taken.has(candidate),
    `cloud-${(manifest.head ?? 'work').slice(0, 8)}`
  )
  await git(repoPath, ['fetch', '--no-tags', bundlePath, `+HEAD:refs/heads/${name}`])
  if (!(await branchExists(repoPath, name))) {
    throw new Error('The cloud branch did not arrive in the local repository.')
  }
  return name
}

export async function applyPatch(
  worktreePath: string,
  patch: string,
  index: boolean,
  leftovers: string
): Promise<boolean> {
  if ((await fileSize(patch)) === 0) {
    return false
  }
  try {
    await git(worktreePath, ['apply', '--whitespace=nowarn', ...(index ? ['--index'] : []), patch])
    return true
  } catch {
    // Keep the user's work even if it no longer applies (e.g. the local branch moved on).
    await mkdir(leftovers, { recursive: true })
    await cp(patch, join(leftovers, patch.split('/').at(-1)!))
    return false
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(dir)
  return out
}

/** Copies session files with the cloud worktree path rewritten; never overwrites an existing local file. */
export async function installSessions(
  sourceDir: string,
  targetDir: string,
  fromRoot: string,
  toRoot: string
): Promise<number> {
  // The source came out of a VM archive: refuse a symlinked root, install transcripts only.
  const root = await lstat(sourceDir).catch(() => null)
  if (!root || !root.isDirectory()) {
    return 0
  }
  let installed = 0
  for (const file of (await listFiles(sourceDir)).filter((name) => name.endsWith('.jsonl'))) {
    const target = join(targetDir, relative(sourceDir, file))
    if (
      await stat(target).then(
        () => true,
        () => false
      )
    ) {
      continue
    }
    await mkdir(join(target, '..'), { recursive: true })
    const text = await readFile(file, 'utf8')
    await writeFile(target, remapSessionTranscript(text, fromRoot, toRoot), { flag: 'wx' })
    if (file.endsWith('.jsonl')) {
      installed++
    }
  }
  return installed
}
