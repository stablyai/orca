import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { isScalar, isSeq, parse, parseDocument, visit } from 'yaml'
import { z } from 'zod'
import type { BacklogTask } from '../../shared/backlog-types'

const Config = z.object({
  project_name: z.string().optional(),
  projectName: z.string().optional(),
  backlog_directory: z.string().optional(),
  backlogDirectory: z.string().optional(),
  statuses: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(100)
    .default(['To Do', 'In Progress', 'Done']),
  auto_commit: z.boolean().optional(),
  autoCommit: z.boolean().optional(),
  remote_operations: z.boolean().optional(),
  remoteOperations: z.boolean().optional(),
  check_active_branches: z.boolean().optional(),
  checkActiveBranches: z.boolean().optional(),
  onStatusChange: z.string().optional(),
  on_status_change: z.string().optional()
})
const Metadata = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z]+-[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/)
    .max(128),
  title: z
    .union([z.string(), z.number().finite(), z.boolean(), z.date(), z.null(), z.undefined()])
    .transform((value) => String(value || ''))
    .pipe(z.string().max(1024)),
  status: z.string().max(200),
  onStatusChange: z.unknown().optional()
})

/** Reads bounded UTF-8 from a regular file, rejecting symlinks at lstat and using O_NOFOLLOW off Windows. */
export async function readBacklogFile(file: string, maxBytes = 131072): Promise<string> {
  const entry = await lstat(file)
  if (!entry.isFile()) {
    throw new Error(`Backlog requires a regular file, not a symlink or special file: ${file}`)
  }
  const handle = await open(
    file,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`Backlog file exceeds the ${maxBytes}-byte limit: ${file}`)
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxBytes) {
      throw new Error(`Backlog file grew beyond the read limit: ${file}`)
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Treats only ENOENT as absent; permission and other filesystem errors remain blocking. */
export async function backlogPathExists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/** Resolves existing project-relative segments, rejecting traversal and symlinks at inspection time. */
export async function containedBacklogPath(root: string, relative: string): Promise<string> {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative) ||
    relative.includes('\\')
  ) {
    throw new Error('Backlog paths must be project-relative.')
  }
  const parts = relative.split('/')
  if (parts.some((part) => part === '..' || part === '.' || !part)) {
    throw new Error('Backlog path traversal is not allowed.')
  }
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Backlog symlinks are not supported: ${current}`)
    }
  }
  return current
}

/** Loads root or conventional Backlog config and records CLI safety/identity mismatches without executing it. */
export async function loadBacklogProject(repoPath: string) {
  const root = await realpath(repoPath)
  const rootConfig = await backlogPathExists(path.join(root, 'backlog.config.yml'))
  let directory: string | undefined
  let configPath: string | undefined
  for (const candidate of ['backlog', '.backlog']) {
    for (const name of ['config.yml', 'config.yaml']) {
      const relative = `${candidate}/${name}`
      if (!configPath && (await backlogPathExists(path.join(root, relative)))) {
        configPath = relative
        directory = candidate
      }
    }
  }
  if (rootConfig) {
    configPath = 'backlog.config.yml'
  }
  if (!configPath) {
    throw new Error(
      'No Backlog.md configuration in this project. Initialize Backlog.md in the selected project first.'
    )
  }
  const configText = await readBacklogFile(await containedBacklogPath(root, configPath), 32768)
  const config = Config.parse(parse(configText))
  // Backlog 1.48 reads these keys line-by-line, including indented lines.
  const cliEntries = configText.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    const colon = trimmed.indexOf(':')
    if (trimmed.startsWith('#') || colon === -1) {
      return []
    }
    return [{ key: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() }]
  })
  const cliConfig = new Map(cliEntries.map(({ key, value }) => [key, value]))
  const unsafeCliConfig =
    cliConfig.get('remote_operations')?.toLowerCase() !== 'false' ||
    cliConfig.get('check_active_branches')?.toLowerCase() !== 'false' ||
    cliEntries.some(({ key, value }) => {
      switch (key) {
        case 'auto_commit':
          return value.toLowerCase() === 'true'
        case 'onStatusChange':
        case 'on_status_change':
          return Boolean(value.replace(/^['"]|['"]$/g, ''))
        case 'remote_operations':
        case 'check_active_branches':
          return value.toLowerCase() !== 'false'
        default:
          return false
      }
    })
  if (rootConfig) {
    directory = config.backlog_directory ?? config.backlogDirectory ?? directory
    if (!directory) {
      for (const candidate of ['backlog', '.backlog']) {
        if (await backlogPathExists(path.join(root, candidate))) {
          directory = candidate
          break
        }
      }
    }
  }
  const projectName = config.project_name ?? config.projectName
  if (!projectName || !directory) {
    throw new Error(
      'Backlog.md configuration needs a project name and an existing backlog directory.'
    )
  }
  const backlogPath = await containedBacklogPath(root, directory)
  const configMatchesCli =
    cliConfig.get('project_name')?.replace(/['"]/g, '') === projectName &&
    cliEntries.every(({ key, value }) => {
      if (key === 'project_name') {
        return value.replace(/['"]/g, '') === projectName
      }
      if (key === 'backlog_directory' || key === 'backlogDirectory') {
        return rootConfig && value.replace(/['"]/g, '') === directory
      }
      return true
    })
  return {
    root,
    backlogPath,
    projectName,
    statuses: config.statuses,
    config,
    unsafeCliConfig,
    configMatchesCli
  }
}

export type BacklogProject = Awaited<ReturnType<typeof loadBacklogProject>>

/** Validates task frontmatter, extracts display content, and flags status hooks before CLI edits. */
export function parseBacklogTask(content: string): BacklogTask & { hasStatusHook: boolean } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content)
  if (!match) {
    throw new Error('Backlog task is missing YAML frontmatter.')
  }
  // Full YAML (including merges and quoted keys) is required to see every executable hook.
  const document = parseDocument(match[1], {
    version: '1.1',
    merge: true,
    // gray-matter treats yes/no/on/off as strings, while retaining YAML dates and octal numbers.
    customTags: (tags) => [
      ...tags.filter((tag) => typeof tag === 'string' || tag.tag !== 'tag:yaml.org,2002:bool'),
      'bool'
    ]
  })
  const allowedAtSigns = new Set<number>()
  visit(document, {
    /** Allows bare @ handles only in assignee/reporter scalars or flow-sequence entries. */
    Pair(_key, pair) {
      if (!isScalar(pair.key) || !['assignee', 'reporter'].includes(String(pair.key.value))) {
        return
      }
      const values = isSeq(pair.value) && pair.value.flow ? pair.value.items : [pair.value]
      for (const value of values) {
        if (
          isScalar(value) &&
          value.type === 'PLAIN' &&
          value.source?.startsWith('@') &&
          value.range
        ) {
          allowedAtSigns.add(value.range[0])
        }
      }
    }
  })
  // Backlog accepts unquoted @ handles; all other YAML failures must remain blocking.
  document.errors = document.errors.filter(
    (error) => error.code !== 'BAD_SCALAR_START' || !allowedAtSigns.has(error.pos[0])
  )
  if (document.errors.length) {
    throw document.errors[0]
  }
  const metadata = Metadata.parse(document.toJS())
  const body = match[2].trim()
  const description =
    /<!-- SECTION:DESCRIPTION:BEGIN -->\s*([\s\S]*?)\s*<!-- SECTION:DESCRIPTION:END -->/.exec(
      body
    )?.[1] ??
    /(?:^|\r?\n)## Description[^\S\r\n]*\r?\n([\s\S]*?)(?=\r?\n## |$)/.exec(body)?.[1]?.trim() ??
    ''
  return {
    id: metadata.id,
    title: metadata.title,
    status: metadata.status,
    description,
    body,
    hasStatusHook: Boolean(metadata.onStatusChange)
  }
}

/** Reads active tasks in numeric ID order; rejects symlinks, duplicate IDs, and scan/read limit violations. */
export async function readBacklogTasks(project: BacklogProject) {
  const tasksPath = path.join(project.backlogPath, 'tasks')
  if (!(await backlogPathExists(tasksPath))) {
    return []
  }
  if ((await lstat(tasksPath)).isSymbolicLink()) {
    throw new Error('Backlog task directory cannot be a symlink.')
  }
  const directory = await opendir(tasksPath)
  const tasks: ReturnType<typeof parseBacklogTask>[] = []
  const ids = new Set<string>()
  let entries = 0
  let bytes = 0
  for await (const entry of directory) {
    if (++entries > 10000) {
      throw new Error('Backlog directory exceeds the 10,000-entry limit.')
    }
    if (entry.isSymbolicLink()) {
      throw new Error('Backlog task symlinks are not supported.')
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue
    }
    const content = await readBacklogFile(path.join(tasksPath, entry.name))
    bytes += Buffer.byteLength(content)
    if (bytes > 16 * 1024 * 1024) {
      throw new Error('Backlog tasks exceed the 16 MiB read limit.')
    }
    const task = parseBacklogTask(content)
    const key = /^[a-z]+-\d+(?:\.\d+)*$/i.test(task.id)
      ? task.id.toLowerCase().replace(/([-.])0+(?=\d)/g, '$1')
      : task.id.toLowerCase()
    if (ids.has(key)) {
      throw new Error(`Duplicate Backlog task ID: ${task.id}. Run backlog doctor.`)
    }
    ids.add(key)
    tasks.push(task)
  }
  const collator = new Intl.Collator(undefined, { numeric: true })
  return tasks.sort((a, b) => collator.compare(a.id, b.id))
}

/** Bounds the recursive CLI scan and rejects symlinks, including completed/archive paths used for ID resolution. */
export async function assertBacklogMutationPaths(
  directory: string,
  budget = { entries: 0 },
  depth = 0
): Promise<void> {
  if (depth > 12) {
    throw new Error('Backlog directory nesting exceeds the supported limit.')
  }
  for await (const entry of await opendir(directory)) {
    if (++budget.entries > 10000) {
      throw new Error('Backlog directory exceeds the mutation safety limit.')
    }
    if (entry.isSymbolicLink()) {
      throw new Error('Remove Backlog symlinks before editing tasks in Orca.')
    }
    if (entry.isDirectory()) {
      await assertBacklogMutationPaths(path.join(directory, entry.name), budget, depth + 1)
    }
  }
}
