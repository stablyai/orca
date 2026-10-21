import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectProcessHostSources } from './check-process-host-imports.mjs'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// Code kept only for old clients, servers or profiles. Each folder is reached only through its
// listed entry modules and only from the listed importers, so deleting the folder plus those
// import lines removes the path.
export const COMPAT_FOLDERS = [
  {
    folder: 'src/shared/workspace-layout/old-client',
    entries: ['old-client-session-tab-rows', 'old-client-session-tabs-projection'],
    importers: [
      'src/main/runtime/terminal/launch/mobile-terminal-chat-fork-create.ts',
      'src/main/runtime/terminal/surface/terminal-surface-index.ts'
    ]
  },
  {
    folder: 'src/main/remote-layout-snapshot',
    entries: ['remote-layout-snapshot-persistence', 'remote-layout-snapshot-recorder'],
    importers: [
      'src/main/ipc/runtime-environments/runtime-environments.ts',
      'src/main/ipc/runtime-environments/runtime-environment-removal-cleanup.ts',
      'src/main/persistence/loading-store/store-domain-composition.ts'
    ]
  }
]

const RENDERER_ALIASES = ['@/', '@renderer/']

function importTarget(file, specifier) {
  const normalized = specifier.replaceAll('\\', '/')
  if (normalized.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(file), normalized))
  }
  const alias =
    file.startsWith('src/renderer/') &&
    RENDERER_ALIASES.find((prefix) => normalized.startsWith(prefix))
  return alias ? `src/renderer/src/${normalized.slice(alias.length)}` : null
}

export function assessCompatBoundaryImports(
  sources,
  folders = COMPAT_FOLDERS,
  specifiersFor = collectModuleSpecifiers
) {
  const violations = []
  const folderNames = folders.map(({ folder }) => path.posix.basename(folder))
  for (const [file, contents] of sources) {
    // Escapes can hide a folder name; relative imports can inherit it from the file path.
    if (
      !contents.includes('\\') &&
      !folderNames.some((name) => contents.includes(name) || file.includes(name))
    ) {
      continue
    }
    for (const specifier of specifiersFor(file, contents)) {
      const target = importTarget(file, specifier)?.replace(/\.[cm]?[jt]sx?$/, '')
      const compat = folders.find(
        ({ folder }) => target === folder || target?.startsWith(`${folder}/`)
      )
      if (!compat || file.startsWith(`${compat.folder}/`)) {
        continue
      }
      if (!compat.entries.some((entry) => target === `${compat.folder}/${entry}`)) {
        violations.push(
          `${file}: import ${compat.folder} through ${compat.entries.join(', ')}, not ${specifier}`
        )
      } else if (!compat.importers.includes(file) && !isTestOnlySourcePath(file)) {
        violations.push(
          `${file}: only ${compat.importers.join(', ') || 'no file'} may import ${compat.folder}`
        )
      }
    }
  }
  return violations.sort()
}

export function main(root, sharedSources, specifiersFor = collectModuleSpecifiers) {
  const violations = assessCompatBoundaryImports(
    sharedSources ?? collectProcessHostSources(root),
    COMPAT_FOLDERS,
    specifiersFor
  )
  if (violations.length > 0) {
    console.error(`[compat-boundary-imports]\n${violations.join('\n')}`)
    return 1
  }
  console.log(`[compat-boundary-imports] ok; ${COMPAT_FOLDERS.length} compatibility folders`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
