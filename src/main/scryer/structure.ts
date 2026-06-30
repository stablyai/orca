import { readdir, readFile } from 'fs/promises'
import { basename, join, relative, sep } from 'path'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.scryer',
  '.next',
  '__pycache__',
  '.direnv',
  '.venv',
  '.turbo',
  '.cache',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.parcel-cache',
  '.webpack',
  'vendor'
])

const SKIP_BUILD_DIRS = new Set(['dist', 'build', 'out', 'target', '.build', 'bin', 'obj', 'pkg'])

type Category = 'manifest' | 'infrastructure' | 'environment'

type TreeNode = {
  isDir: boolean
  annotation?: Category
  children: Map<string, TreeNode>
  hasAnnotatedDescendant: boolean
}

function createDirNode(): TreeNode {
  return { isDir: true, children: new Map(), hasAnnotatedDescendant: false }
}

function createFileNode(annotation?: Category): TreeNode {
  return { isDir: false, annotation, children: new Map(), hasAnnotatedDescendant: false }
}

function normalizePath(value: string): string {
  return value.split(sep).join('/')
}

function classifyFile(name: string, relPath: string): Category | undefined {
  if (
    [
      'package.json',
      'Cargo.toml',
      'go.mod',
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'Gemfile',
      'composer.json',
      'mix.exs',
      'pubspec.yaml',
      'Package.swift',
      'Makefile',
      'CMakeLists.txt',
      'deno.json',
      'deno.jsonc',
      'bun.lock',
      'flake.nix'
    ].includes(name) ||
    name.endsWith('.csproj') ||
    name.endsWith('.fsproj') ||
    name.endsWith('.sln')
  ) {
    return 'manifest'
  }

  if (
    [
      'fly.toml',
      'Procfile',
      'vercel.json',
      'netlify.toml',
      'render.yaml',
      'railway.json',
      'app.yaml',
      'Jenkinsfile',
      'shell.nix',
      'docker-compose.yml',
      'docker-compose.yaml',
      'serverless.yml',
      'serverless.yaml',
      'skaffold.yaml',
      'template.yaml',
      'template.yml',
      'sam.yaml',
      'sam.yml',
      'deploy.yml',
      'deploy.yaml',
      '.gitlab-ci.yml'
    ].includes(name) ||
    name.startsWith('Dockerfile') ||
    (name.startsWith('docker-compose') && (name.endsWith('.yml') || name.endsWith('.yaml'))) ||
    name.endsWith('.tf') ||
    name.endsWith('.tfvars') ||
    (relPath.startsWith('.github/workflows/') &&
      (name.endsWith('.yml') || name.endsWith('.yaml'))) ||
    (relPath.startsWith('.circleci/') && name === 'config.yml') ||
    ((relPath.startsWith('k8s/') ||
      relPath.startsWith('kubernetes/') ||
      relPath.startsWith('deploy/') ||
      relPath.startsWith('infra/')) &&
      (name.endsWith('.yml') || name.endsWith('.yaml')))
  ) {
    return 'infrastructure'
  }

  if (['.env.example', '.env.sample', '.env.template'].includes(name)) {
    return 'environment'
  }

  return undefined
}

function ensureDir(root: TreeNode, parts: string[]): TreeNode {
  let current = root
  for (const part of parts) {
    let child = current.children.get(part)
    if (!child) {
      child = createDirNode()
      current.children.set(part, child)
    }
    current = child
  }
  return current
}

async function readIgnoreEntries(root: string): Promise<Set<string>> {
  try {
    const content = await readFile(join(root, '.gitignore'), 'utf8')
    return new Set(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && !line.includes('*'))
        .map((line) => line.replace(/^\/+/, '').replace(/\/+$/, ''))
    )
  } catch {
    return new Set()
  }
}

function shouldSkip(relPath: string, name: string, ignored: Set<string>): boolean {
  if (SKIP_DIRS.has(name) || SKIP_BUILD_DIRS.has(name)) {
    return true
  }
  return ignored.has(name) || ignored.has(relPath)
}

async function addPath(
  root: TreeNode,
  rootPath: string,
  fullPath: string,
  ignored: Set<string>
): Promise<void> {
  const entries = await readdir(fullPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(fullPath, entry.name)
    const relPath = normalizePath(relative(rootPath, entryPath))
    if (entry.isDirectory()) {
      if (shouldSkip(relPath, entry.name, ignored)) {
        continue
      }
      ensureDir(root, relPath.split('/'))
      await addPath(root, rootPath, entryPath, ignored)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (shouldSkip(relPath, entry.name, ignored)) {
      continue
    }
    const parts = relPath.split('/')
    const parent = parts.length > 1 ? ensureDir(root, parts.slice(0, -1)) : root
    parent.children.set(entry.name, createFileNode(classifyFile(entry.name, relPath)))
  }
}

function propagateAnnotations(node: TreeNode): boolean {
  if (!node.isDir) {
    return node.annotation !== undefined
  }
  let any = false
  for (const child of node.children.values()) {
    if (propagateAnnotations(child)) {
      any = true
    }
  }
  node.hasAnnotatedDescendant = any
  return any
}

function renderNode(node: TreeNode, prefix: string, depth: number, output: string[]): void {
  const children = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))
  const visible: [string, TreeNode][] = []
  let hiddenCount = 0

  for (const [name, child] of children) {
    if (!child.isDir && child.annotation) {
      visible.push([name, child])
    } else if (child.isDir && (child.hasAnnotatedDescendant || depth < 1)) {
      visible.push([name, child])
    } else {
      hiddenCount += 1
    }
  }

  if (hiddenCount > 0) {
    visible.push([`... (${hiddenCount} more)`, createFileNode()])
  }

  visible.forEach(([name, child], index) => {
    const isLast = index === visible.length - 1
    const connector = isLast ? '`-- ' : '|-- '
    if (child.isDir) {
      output.push(`${prefix}${connector}${name}/`)
      renderNode(child, `${prefix}${isLast ? '    ' : '|   '}`, depth + 1, output)
      return
    }
    const annotation = child.annotation ? ` [${child.annotation}]` : ''
    output.push(`${prefix}${connector}${name}${annotation}`)
  })
}

export async function projectStructure(projectPath: string): Promise<string> {
  const ignored = await readIgnoreEntries(projectPath)
  const root = createDirNode()
  await addPath(root, projectPath, projectPath, ignored)
  propagateAnnotations(root)
  const output = [`${basename(projectPath) || '.'}/`]
  renderNode(root, '', 0, output)
  return `${output.join('\n')}\n`
}
