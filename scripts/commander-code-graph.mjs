#!/usr/bin/env node
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'

const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/i
const maxFileBytes = 128 * 1024
const maxTotalBytes = 8 * 1024 * 1024
const maxEdges = 500
const help =
  'orca-commander-code-graph [--scope <repository-relative file or directory>] [--max-files 1..200] [--json]'

async function git(cwd, args) {
  const result = await runProcess({
    program: 'git',
    cwd,
    args,
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024 * 1024,
    killOnOutputLimit: true
  })
  if (result.outputTruncated) {
    throw new Error('Repository file listing exceeds the 8 MiB limit')
  }
  if (result.code !== 0 || result.timedOut) {
    throw new Error('Cannot read the Git checkout')
  }
  return result.stdout
}

function normalizeScope(value) {
  if (typeof value !== 'string' || win32.parse(value).root || value.includes('\0')) {
    throw new Error('Expected a repository-relative file or directory')
  }
  // Git lists tracked paths with forward slashes on every host.
  const relative = value.replaceAll('\\', '/')
  if (relative.split('/').includes('..')) {
    throw new Error('Expected a repository-relative file or directory')
  }
  return posix.normalize(relative || '.').replace(/\/$/, '')
}

async function readSource(root, file, available) {
  const path = join(root, file)
  if ((await realpath(path)) !== path) {
    return null
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxFileBytes || stat.size > available) {
      return null
    }
    const bytes = Buffer.alloc(stat.size)
    let n = 0
    while (n < bytes.length) {
      const { bytesRead } = await handle.read(bytes, n, bytes.length - n)
      if (!bytesRead) {
        break
      }
      n += bytesRead
    }
    const data = bytes.subarray(0, n)
    return data.includes(0) ? null : data
  } finally {
    await handle.close()
  }
}

export async function collectCommanderCodeGraph({
  cwd = process.cwd(),
  scope = '.',
  maxFiles = 80
} = {}) {
  scope = normalizeScope(scope)
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 200) {
    throw new Error('maxFiles must be between 1 and 200')
  }
  const root = await realpath(
    (await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')
  )
  const [listing, head] = await Promise.all([
    git(root, ['ls-files', '--stage', '-z']),
    git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')
  ])
  const indexed = new Set()
  for (const row of listing.split('\0')) {
    const match = /^100(?:644|755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(row)
    if (match) {
      indexed.add(match[1])
    }
  }
  const inScope = [...indexed].filter(
    (file) => scope === '.' || file === scope || file.startsWith(`${scope}/`)
  )
  const sources = inScope.filter((file) => sourceFile.test(file))
  const ts = (await import('typescript-api')).default
  const options = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true
  }
  const host = { fileExists: (file) => indexed.has(file.slice(1)), readFile: () => undefined }
  const coverage = {
    trackedInScope: inScope.length,
    sourcesInScope: sources.length,
    scanned: 0,
    skipped: 0,
    remaining: sources.length,
    unresolvedRelativeImports: 0,
    edgeLimitReached: false
  }
  const edges = []
  const nodes = new Set()
  let bytesLeft = maxTotalBytes
  for (const file of sources.slice(0, maxFiles)) {
    if (bytesLeft === 0 || coverage.edgeLimitReached) {
      break
    }
    coverage.remaining--
    const data = await readSource(root, file, bytesLeft).catch((error) => {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) {
        return null
      }
      throw error
    })
    if (!data) {
      coverage.skipped++
      continue
    }
    coverage.scanned++
    bytesLeft -= data.length
    nodes.add(file)
    const text = data.toString('utf8')
    const lineStarts = ts.computeLineStarts(text)
    for (const item of ts.preProcessFile(text, true, true).importedFiles) {
      if (!/^(?:\.\.?)(?:\/|$)/.test(item.fileName)) {
        continue
      }
      const base = posix.join(posix.dirname(file), item.fileName)
      if (base === '..' || base.startsWith('../')) {
        coverage.unresolvedRelativeImports++
        continue
      }
      const resolved = ts.resolveModuleName(item.fileName, `/${file}`, options, host).resolvedModule
      if (!resolved) {
        coverage.unresolvedRelativeImports++
        continue
      }
      if (edges.length === maxEdges) {
        coverage.edgeLimitReached = true
        break
      }
      const to = resolved.resolvedFileName.slice(1)
      nodes.add(to)
      edges.push({
        from: file,
        to,
        line: ts.computeLineAndCharacterOfPosition(lineStarts, item.pos).line + 1
      })
    }
  }
  return {
    source:
      'Relative imports in tracked JavaScript and TypeScript working files. Targets are resolved against the Git index.',
    scope,
    commit: head.trim() || null,
    nodes: [...nodes],
    edges,
    coverage
  }
}

function formatGraph(graph) {
  const { coverage } = graph
  const lines = [
    `${graph.source}\n${coverage.scanned}/${coverage.sourcesInScope} source files scanned, ${graph.edges.length} import sites.`
  ]
  const outgoing = Map.groupBy(graph.edges, (edge) => edge.from)
  const targets = new Set(graph.edges.map((edge) => edge.to))
  for (const file of graph.nodes) {
    if (targets.has(file) && !outgoing.has(file)) {
      continue
    }
    lines.push(JSON.stringify(file))
    for (const { line, to } of outgoing.get(file) ?? []) {
      lines.push(`  L${line} → ${JSON.stringify(to)}`)
    }
  }
  if (
    coverage.skipped ||
    coverage.remaining ||
    coverage.edgeLimitReached ||
    coverage.unresolvedRelativeImports
  ) {
    lines.push(
      `Skipped ${coverage.skipped} files, ${coverage.remaining} files remaining, ${coverage.unresolvedRelativeImports} unresolved relative imports.`
    )
  }
  if (coverage.edgeLimitReached) {
    lines.push('Edge limit reached. Select a narrower scope for more detail.')
  }
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        scope: { type: 'string' },
        'max-files': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' }
      }
    })
    if (values.help) {
      console.log(help)
    } else {
      const graph = await collectCommanderCodeGraph({
        scope: values.scope,
        maxFiles: Number(values['max-files'] ?? 80)
      })
      console.log(values.json ? JSON.stringify(graph) : formatGraph(graph))
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
