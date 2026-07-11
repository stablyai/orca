import { spawnSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import type { NormalizedOutputOptions, OutputBundle, OutputChunk, Plugin } from 'rollup'
import { parseAst } from 'rollup/parseAst'

// Why: v1.4.129-rc.1 shipped a dead terminal daemon because a shared main
// chunk gained `require("electron")` (an import edge added in #7642), and the
// daemon is forked as a plain-Node process where electron cannot be required.
// Nothing in CI executes the built daemon-entry under plain Node, so the leak
// stayed invisible until an adopted old daemon died. This guard fails the
// build when any chunk reachable from a plain-Node fork entry requires
// electron, and smoke-loads daemon-entry under plain Node to prove its module
// graph still resolves.

// Entries executed as plain Node (ELECTRON_RUN_AS_NODE / no electron runtime):
// forked daemon, parcel-watcher hosts, computer sidecar, and the CLI-run
// agent-hooks entry. require("electron") throws MODULE_NOT_FOUND in all of them.
const PLAIN_NODE_ENTRY_NAMES = [
  'daemon-entry',
  'parcel-watcher-process-entry',
  'wsl-watcher-host',
  'computer-sidecar',
  'agent-hooks/managed-agent-hook-controls'
] as const

const ELECTRON_REQUIRE_RE = /require\(\s*["']electron["']\s*\)/
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

type AstNode = { type: string; [key: string]: unknown }

function isAstNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === 'object' && typeof (value as AstNode).type === 'string')
}

function walkAst(
  node: AstNode,
  visit: (node: AstNode, parent: AstNode | null, grandparent: AstNode | null) => void,
  parent: AstNode | null = null,
  grandparent: AstNode | null = null
): void {
  visit(node, parent, grandparent)
  for (const value of Object.values(node)) {
    if (isAstNode(value)) {
      walkAst(value, visit, node, parent)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          walkAst(item, visit, node, parent)
        }
      }
    }
  }
}

function isAllowedWslHostDependency(specifier: string): boolean {
  return specifier === './watcher.node' || NODE_BUILTINS.has(specifier)
}

function literalSpecifier(argument: unknown): string | undefined {
  if (!isAstNode(argument) || argument.type !== 'Literal') {
    return undefined
  }
  return typeof argument.value === 'string' ? argument.value : undefined
}

function memberName(node: AstNode): string | undefined {
  if (node.type !== 'MemberExpression' || !isAstNode(node.property)) {
    return undefined
  }
  if (node.property.type === 'Identifier' && node.computed !== true) {
    return typeof node.property.name === 'string' ? node.property.name : undefined
  }
  return node.property.type === 'Literal' && typeof node.property.value === 'string'
    ? node.property.value
    : undefined
}

function identifierName(node: unknown): string | undefined {
  return isAstNode(node) && node.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : undefined
}

function assertAllowedLoaderArgument(argument: unknown): void {
  const specifier = literalSpecifier(argument)
  if (!specifier || !isAllowedWslHostDependency(specifier)) {
    throw new Error(
      `[plain-node-entry-guard] "wsl-watcher-host" loads unavailable dependency ` +
        `"${specifier ?? 'dynamic expression'}". Only Node built-ins and ./watcher.node are staged in WSL.`
    )
  }
}

function loaderProofError(kind: string): Error {
  return new Error(
    `[plain-node-entry-guard] "wsl-watcher-host" ${kind}, so its staged dependencies cannot be proven.`
  )
}

function assertDirectWslHostLoaders(code: string): void {
  const ast = parseAst(code) as unknown as AstNode
  walkAst(ast, (node, parent, grandparent) => {
    if (node.type === 'ImportExpression') {
      assertAllowedLoaderArgument(node.source)
      return
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee
      const firstArgument = Array.isArray(node.arguments) ? node.arguments[0] : undefined
      if (identifierName(callee) === 'require') {
        assertAllowedLoaderArgument(firstArgument)
        return
      }
      if (isAstNode(callee) && callee.type === 'MemberExpression') {
        const owner = identifierName(callee.object)
        const property = memberName(callee)
        if (
          (owner === 'require' && property === 'resolve') ||
          (owner === 'module' && property === 'require') ||
          (owner === 'process' && property === 'getBuiltinModule')
        ) {
          assertAllowedLoaderArgument(firstArgument)
          return
        }
        if (property === 'createRequire') {
          throw loaderProofError('uses createRequire')
        }
      }
    }
    if (node.type === 'Identifier' && node.name === 'createRequire') {
      throw loaderProofError('uses createRequire')
    }
    if (node.type === 'Identifier' && node.name === 'require') {
      const directCall = parent?.type === 'CallExpression' && parent.callee === node
      const directResolve =
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        memberName(parent) === 'resolve' &&
        grandparent?.type === 'CallExpression' &&
        grandparent.callee === parent
      const propertyNameOnly =
        parent?.type === 'MemberExpression' && parent.property === node && parent.computed !== true
      const nonLoaderMetadata =
        parent?.type === 'MemberExpression' &&
        parent.object === node &&
        ['cache', 'extensions', 'main'].includes(memberName(parent) ?? '')
      if (!directCall && !directResolve && !propertyNameOnly && !nonLoaderMetadata) {
        throw loaderProofError('aliases require')
      }
    }
    if (
      node.type === 'MemberExpression' &&
      node.computed === true &&
      ['Module', 'module', 'process', 'require'].includes(identifierName(node.object) ?? '')
    ) {
      throw loaderProofError('uses a computed module loader property')
    }
    if (node.type === 'MemberExpression' && memberName(node) === 'require') {
      const directModuleCall =
        identifierName(node.object) === 'module' &&
        parent?.type === 'CallExpression' &&
        parent.callee === node
      if (!directModuleCall) {
        throw loaderProofError('uses an indirect require loader')
      }
    }
    if (
      node.type === 'Property' &&
      parent?.type === 'ObjectPattern' &&
      (identifierName(node.key) === 'require' || literalSpecifier(node.key) === 'require')
    ) {
      throw loaderProofError('aliases require')
    }
  })
}

function assertWslWatcherHostSelfContained(
  entry: OutputChunk,
  byFileName: Map<string, OutputChunk>
): void {
  const linkedFiles = [
    ...entry.imports,
    ...entry.dynamicImports,
    ...(entry.implicitlyLoadedBefore ?? [])
  ]
  for (const imported of linkedFiles) {
    if (byFileName.has(imported)) {
      throw new Error(
        `[plain-node-entry-guard] "wsl-watcher-host" reaches shared chunk "${imported}". ` +
          `The staged Linux host only ships host.js and watcher.node, so its JavaScript ` +
          `module graph must be bundled into the entry.`
      )
    }
    if (!isAllowedWslHostDependency(imported)) {
      throw new Error(
        `[plain-node-entry-guard] "wsl-watcher-host" imports external dependency ` +
          `"${imported}". Only Node built-ins and ./watcher.node are staged in WSL.`
      )
    }
  }

  for (const referenced of entry.referencedFiles ?? []) {
    const normalized = referenced.replaceAll('\\', '/')
    if (normalized !== 'watcher.node' && normalized !== './watcher.node') {
      throw new Error(
        `[plain-node-entry-guard] "wsl-watcher-host" references unstaged asset ` +
          `"${referenced}".`
      )
    }
  }

  assertDirectWslHostLoaders(entry.code)
}

function collectReachableChunks(
  entry: OutputChunk,
  byFileName: Map<string, OutputChunk>
): OutputChunk[] {
  const seen = new Set<string>()
  const reachable: OutputChunk[] = []
  const stack = [entry.fileName]
  while (stack.length > 0) {
    const fileName = stack.pop() as string
    if (seen.has(fileName)) {
      continue
    }
    seen.add(fileName)
    const chunk = byFileName.get(fileName)
    if (!chunk) {
      continue
    }
    reachable.push(chunk)
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      stack.push(imported)
    }
  }
  return reachable
}

function assertNoElectronRequire(
  entryName: string,
  entry: OutputChunk,
  byFileName: Map<string, OutputChunk>
): void {
  for (const chunk of collectReachableChunks(entry, byFileName)) {
    if (ELECTRON_REQUIRE_RE.test(chunk.code)) {
      throw new Error(
        `[plain-node-entry-guard] "${entryName}" reaches chunk "${chunk.fileName}" that ` +
          `requires electron. "${entryName}" runs as a plain-Node process, where ` +
          `require("electron") throws MODULE_NOT_FOUND and kills it at startup (the ` +
          `v1.4.129-rc.1 daemon outage). Keep electron imports out of its module graph.`
      )
    }
  }
}

// Why: proves the whole daemon-entry graph resolves under plain Node (no
// unresolved requires). require("electron") does not throw in a dev tree with
// node_modules present, so the static scan above — not this smoke — is the
// electron regression guard; this only catches gross load failures.
function smokeLoadDaemonEntry(outputDir: string): void {
  const entryPath = join(outputDir, 'daemon-entry.js')
  const result = spawnSync(process.execPath, [entryPath], {
    encoding: 'utf8',
    timeout: 15_000
  })
  if (result.error) {
    throw new Error(
      `[plain-node-entry-guard] could not smoke-load daemon-entry.js under plain Node: ` +
        `${result.error.message}`
    )
  }
  const stderr = result.stderr ?? ''
  if (/Cannot find module|MODULE_NOT_FOUND/.test(stderr)) {
    throw new Error(
      `[plain-node-entry-guard] daemon-entry.js failed to load under plain Node:\n${stderr}`
    )
  }
  if (!stderr.includes('Usage: daemon-entry')) {
    throw new Error(
      `[plain-node-entry-guard] daemon-entry.js did not reach argv parsing under plain Node ` +
        `(expected the "Usage: daemon-entry" error). stderr:\n${stderr}`
    )
  }
}

export function createPlainNodeEntryGuardPlugin(): Plugin {
  return {
    name: 'orca-plain-node-entry-guard',
    writeBundle(options: NormalizedOutputOptions, bundle: OutputBundle) {
      // Why: skip in `electron-vite dev` watch mode — the smoke would respawn on
      // every rebuild, and the guard only needs to gate produced builds.
      if (this.meta.watchMode) {
        return
      }
      const chunks = Object.values(bundle).filter(
        (item): item is OutputChunk => item.type === 'chunk'
      )
      const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
      const entryByName = new Map<string, OutputChunk>()
      for (const chunk of chunks) {
        if (chunk.isEntry && chunk.name) {
          entryByName.set(chunk.name, chunk)
        }
      }

      for (const entryName of PLAIN_NODE_ENTRY_NAMES) {
        const entry = entryByName.get(entryName)
        if (entry) {
          assertNoElectronRequire(entryName, entry, byFileName)
          if (entryName === 'wsl-watcher-host') {
            assertWslWatcherHostSelfContained(entry, byFileName)
          }
        }
      }

      if (entryByName.has('daemon-entry') && options.dir) {
        smokeLoadDaemonEntry(options.dir)
      }
    }
  }
}
