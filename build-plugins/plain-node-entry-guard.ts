import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { NormalizedOutputOptions, OutputBundle, OutputChunk, Plugin } from 'rollup'

// Why: v1.4.129-rc.1 shipped a dead terminal daemon because a shared main
// chunk gained `require("electron")` (an import edge added in #7642), and the
// daemon is forked as a plain-Node process where electron cannot be required.
// Nothing in CI executes the built daemon-entry under plain Node, so the leak
// stayed invisible until an adopted old daemon died. This guard fails the
// build when any chunk reachable from a plain-Node fork entry requires
// electron, and smoke-loads daemon-entry under plain Node to prove its module
// graph still resolves.

// Entries executed as plain Node (ELECTRON_RUN_AS_NODE / no electron runtime):
// forked daemon, parcel-watcher and computer sidecars, and the CLI-run
// agent-hooks entry. require("electron") throws MODULE_NOT_FOUND in all of them.
const PLAIN_NODE_ENTRY_NAMES = [
  'daemon-entry',
  'parcel-watcher-process-entry',
  'computer-sidecar',
  'agent-hooks/managed-agent-hook-controls',
  'codex/codex-app-server-grant-entry'
] as const

const ELECTRON_REQUIRE_RE = /require\(\s*["']electron["']\s*\)/

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
        }
      }

      if (entryByName.has('daemon-entry') && options.dir) {
        smokeLoadDaemonEntry(options.dir)
      }
    }
  }
}
