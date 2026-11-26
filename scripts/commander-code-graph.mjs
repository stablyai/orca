#!/usr/bin/env node
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { parseArgs } from 'node:util'
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

async function readTrackedFile(root, file, available) {
  try {
    return await readSource(root, file, available)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) {
      return null
    }
    throw error
  }
}

function moduleSpecifiers(ts, source) {
  const literals = []
  function include(node) {
    if (node && ts.isStringLiteralLike(node)) {
      literals.push(node)
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      include(node.moduleSpecifier)
    } else if (ts.isExternalModuleReference(node)) {
      include(node.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      include(node.argument.literal)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require')
      ) {
        include(node.arguments[0])
      } else if (ts.isIdentifier(callee) && callee.text === 'define') {
        const [first, second] = node.arguments
        const dependencies = first && ts.isStringLiteralLike(first) ? second : first
        if (dependencies && ts.isArrayLiteralExpression(dependencies)) {
          dependencies.elements.forEach(include)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return literals
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
  const manifests = new Map()
  const host = {
    fileExists: (file) => indexed.has(file.slice(1)),
    readFile: (file) => manifests.get(file.slice(1))
  }
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
    const data = await readTrackedFile(root, file, bytesLeft)
    if (!data) {
      coverage.skipped++
      continue
    }
    coverage.scanned++
    bytesLeft -= data.length
    nodes.add(file)
    const text = data.toString('utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest)
    for (const specifier of moduleSpecifiers(ts, source)) {
      if (!/^(?:\.\.?)(?:\/|$)/.test(specifier.text)) {
        continue
      }
      const base = posix.join(posix.dirname(file), specifier.text)
      if (base === '..' || base.startsWith('../')) {
        coverage.unresolvedRelativeImports++
        continue
      }
      const manifest = posix.join(base, 'package.json')
      if (indexed.has(manifest) && !manifests.has(manifest) && manifests.size < maxEdges) {
        const content = await readTrackedFile(root, manifest, bytesLeft)
        manifests.set(manifest, content?.toString('utf8'))
        bytesLeft -= content?.length ?? 0
      }
      const resolved = ts.resolveModuleName(
        specifier.text,
        `/${file}`,
        options,
        host
      ).resolvedModule
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
        line: source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1
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

if (import.meta.main) {
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
