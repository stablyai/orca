import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import base from '../../vitest.config.ts'
import { same, containedFile, scalar, fields, field } from './installation-metadata.mjs'
import { createPackageResolution } from './package-resolution.mjs'
import { createModuleObservation, writeRuntimeReceipt } from './module-observation.mjs'

const packet = import.meta.dirname
const root = resolve(packet, '../../..')
const require = createRequire(import.meta.url)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const source = (file) => readFileSync(containedFile(packet, resolve(packet, file)), 'utf8')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (
  process.env.CI !== 'true' ||
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
  process.env.GITHUB_RUN_ATTEMPT !== '1'
) {
  throw new Error('R4 requires the one genuine hosted first attempt')
}
if (process.env.ORCA_PNPM_FORCE_GLOBAL_VIRTUAL_STORE_IN_CI === '1') {
  throw new Error('R4 requires ordinary CI store policy')
}
if (process.versions.bun || !process.versions.node.startsWith('24.')) {
  throw new Error('R4 requires direct Node24')
}
if (
  process.env.ORCA_UNIT_MODULE_CACHE_PATH ||
  process.env.NODE_PATH ||
  process.env.NODE_OPTIONS ||
  process.execArgv.length
) {
  throw new Error('R4 requires cold transforms and unmodified Node resolution')
}
const canonicalRoot = realpathSync(root)
const pins = JSON.parse(readFileSync(resolve(packet, 'input-pins.json'), 'utf8'))
const output = resolve(root, 'r4-evidence')
const claim = JSON.parse(readFileSync(resolve(output, 'invocation-claim.json'), 'utf8'))
if (
  claim.head !== head ||
  claim.productionHead !== pins.productionHead ||
  claim.runId !== process.env.GITHUB_RUN_ID
) {
  throw new Error('R4 lacks the literal runner invocation claim')
}
const {
  lockDocument,
  nodeModules,
  metadataFile,
  metadataBytes,
  metadataReceipt,
  virtualStoreLogical,
  virtualStore,
  generatedLockReceipt,
  provenance,
  proven,
  fromOwn,
  prove,
  own,
  resolveFrom,
  locate,
  pmLocate,
  esmFile
} = createPackageResolution({
  root,
  canonicalRoot,
  require,
  sha,
  configFilename: import.meta.filename,
  output
})
const tool = fromOwn('vitest/config')
const toolEsmURL = import.meta.resolve('vitest/config')
const toolEsm = prove(
  {
    ...own,
    label: 'config-import-meta-resolve-cross-check',
    lookupSemantics:
      'own packet require.resolve.paths corroboration; bundler ESM origin remains unproved'
  },
  'vitest/config',
  fileURLToPath(toolEsmURL)
)
if (!same(toolEsm.directory, tool.directory)) {
  throw new Error('N1 Vitest import/require selected different packages')
}
const baseViteContext = {
  resolver: createRequire(resolve(root, 'config/vitest.config.ts')),
  label: 'base-config-resolution-only',
  anchor: resolve(root, 'config/vitest.config.ts')
}
prove(baseViteContext, 'vite', baseViteContext.resolver.resolve('vite'))
const cli = containedFile(tool.directory, resolve(tool.directory, 'vitest.mjs'))
if (
  !same(realpathSync(resolve(root, 'node_modules/vitest/vitest.mjs')), cli) ||
  !process.argv[1] ||
  !same(realpathSync(process.argv[1]), cli)
) {
  throw new Error('N1 invocation did not enter through the proven own Vitest CLI')
}
const patchPath = containedFile(root, resolve(root, 'config/patches/vitest@5.0.5.patch'))
const patchBytes = readFileSync(patchPath),
  patchIdentity = scalar(
    field(field(lockDocument, 0, 'patchedDependencies').children, 2, 'vitest@5.0.5').value
  )
if (
  sha(patchBytes) !== patchIdentity ||
  !tool.snapshot.key.includes(`(patch_hash=${patchIdentity})`)
) {
  throw new Error('N1 actual Vitest route lacks the frozen patch identity')
}
const patchTarget = containedFile(
  tool.directory,
  resolve(tool.directory, 'dist/chunks/cli-api.De07GUeT.js')
)
const patchTargetBytes = readFileSync(patchTarget)
if (
  !patchTargetBytes
    .toString('utf8')
    .includes(
      '!project.vite.moduleGraph.getModuleById(file)?.transformResult && existsSync(file) && statSync(file).isFile()'
    )
) {
  throw new Error('N1 installed Vitest target lacks the exact inspected patch change')
}
const sourceConfigPins = Object.fromEntries(
  ['package.json', 'pnpm-workspace.yaml', 'config/pnpmfile.cjs'].map((path) => [
    path,
    sha(readFileSync(containedFile(root, resolve(root, path))))
  ])
)
for (const [path, expected] of Object.entries({
  'package.json': '56b0768954eac29c7577d0182e33b309ef4b5bd41a86c663affb6b6c626155b3',
  'pnpm-workspace.yaml': '0d36065492aba004fe72927087364e714f077a090b8996775ce3e603a02a78b3',
  'config/pnpmfile.cjs': 'ea5eaa7605072b24cb60840bc7f5067c6467122157c486929463202b89adb44c'
})) {
  if (sourceConfigPins[path] !== expected) {
    throw new Error(`N1 own-install source pin differs: ${path}`)
  }
}
const versions = {}
for (const [name, expected] of Object.entries({
  'prosemirror-view': '1.42.3',
  'prosemirror-state': '1.4.4',
  'prosemirror-tables': '1.8.5',
  'prosemirror-model': '1.25.11',
  'prosemirror-transform': '1.12.0',
  '@tiptap/core': '3.31.3',
  '@tiptap/pm': '3.31.3',
  'happy-dom': '21.0.4',
  vitest: '5.0.5',
  react: '19.2.8',
  'react-dom': '19.2.8',
  vite: '8.3.5'
})) {
  const info = name.startsWith('prosemirror-')
    ? pmLocate(name)
    : locate(name === '@tiptap/pm' ? '@tiptap/pm/view' : name)
  if (info.json.version !== expected) {
    throw new Error(`${name} version mismatch`)
  }
  versions[name] = {
    version: info.json.version,
    directory: info.directory,
    logicalDirectory: info.logical,
    esm: info.json.module,
    selected: info.selected
  }
}
const installedView = readFileSync(
  containedFile(
    versions['prosemirror-view'].directory,
    resolve(versions['prosemirror-view'].directory, 'dist/index.js')
  )
)
if (
  sha(installedView) !==
  sha(readFileSync(containedFile(packet, resolve(packet, 'engine/original-index.source'))))
) {
  throw new Error(
    'Installed pinned engine ESM differs from exact logged source; STOP, no adaptive rewrite'
  )
}
for (const path of [
  'config/vitest.config.ts',
  'config/scripts/ci-unit-files.mjs',
  'config/scripts/vitest-dom-setup.ts',
  'pnpm-lock.yaml'
]) {
  if (sha(readFileSync(containedFile(root, resolve(root, path)))) !== pins.files[path]) {
    throw new Error(`R4 unchanged2db config/whole-lock mismatch: ${path}`)
  }
}
const named = relative(root, resolve(packet, 'n1-acceptance-contract.test.tsx')).replaceAll(
  '\\',
  '/'
)
const dependencySourceReceipts = []
const sourceNames = [
  '@tiptap/core',
  '@tiptap/starter-kit',
  '@tiptap/extensions',
  '@tiptap/extension-link',
  '@tiptap/extension-code',
  '@tiptap/extension-image',
  '@tiptap/extension-placeholder',
  '@tiptap/extension-list',
  '@tiptap/extension-table',
  '@tiptap/extension-mathematics',
  '@tiptap/extension-details',
  '@tiptap/extension-code-block-lowlight',
  '@tiptap/extension-code-block',
  '@tiptap/markdown',
  '@tiptap/react',
  'prosemirror-state',
  'prosemirror-tables',
  'prosemirror-model',
  'prosemirror-transform',
  'prosemirror-commands',
  'prosemirror-inputrules',
  'prosemirror-history',
  'prosemirror-gapcursor',
  'prosemirror-dropcursor'
]
for (const name of sourceNames) {
  const info = name.startsWith('prosemirror-') ? pmLocate(name) : locate(name)
  const installed = esmFile(info),
    bytes = readFileSync(installed)
  const destination = `installed-${name.replaceAll('@', '').replaceAll('/', '-')}.mjs`
  if (bytes.length > 16 * 1024 * 1024) {
    throw new Error('R4 installed source exceeds file bound')
  }
  writeFileSync(resolve(output, destination), bytes)
  dependencySourceReceipts.push({
    name,
    version: info.json.version,
    installed,
    logicalDirectory: info.logical,
    destination,
    sha256: sha(bytes)
  })
}
// Resolution-only corroboration of relevant dependency/peer seams, never a new source selection.
const initialPackages = [...proven.values()]
const relevantNames = new Set([...Object.keys(versions), ...sourceNames])
const seamReceipts = []
for (const origin of initialPackages) {
  const context = {
    resolver: createRequire(origin.selected),
    origin,
    label: 'receipt-only-selected-package-seam',
    anchor: origin.selected
  }
  for (const group of ['dependencies', 'optionalDependencies']) {
    const section = field(origin.snapshot.children, 4, group, false)
    for (const edge of section ? fields(section.children, 6) : []) {
      if (!relevantNames.has(edge.key)) {
        continue
      }
      const specifier = edge.key === '@tiptap/pm' ? '@tiptap/pm/view' : edge.key
      const info = resolveFrom(context, specifier)
      if (!info) {
        throw new Error(
          `N1 missing actual selected-package dependency/peer seam: ${origin.name} -> ${edge.key}`
        )
      }
      seamReceipts.push({
        from: origin.directory,
        fromSnapshot: origin.snapshot.key,
        to: info.directory,
        toSnapshot: info.snapshot.key,
        specifier,
        peerDeclared: Object.hasOwn(origin.json.peerDependencies || {}, edge.key)
      })
    }
  }
}
writeFileSync(
  resolve(output, 'installed-source-receipts.json'),
  JSON.stringify(dependencySourceReceipts, null, 2)
)
const protocolMap = {
  main: 'protocols/main.source',
  current: 'protocols/current.source',
  ordered: 'protocols/ordered-a.source',
  routed: 'protocols/routed.ts'
}
const engineId = resolve(packet, 'engine/observed-index.mjs')
if (
  !Array.isArray(base.test?.projects) ||
  base.test.projects.some((p) => !p || typeof p !== 'object' || !p.test)
) {
  throw new Error('Inspected base inline project interface changed')
}
const node = base.test.projects.find((p) => p.test.name === 'node')
if (!node || node.test.pool !== 'forks' || node.test.environment !== 'node') {
  throw new Error('Inspected Node project changed')
}
const aliases = [
  { find: /^prosemirror-view$/, replacement: engineId },
  ...['prosemirror-state', 'prosemirror-model', 'prosemirror-transform'].map((name) => {
    if (!versions[name].esm) {
      throw new Error(`Pinned package lacks inspected ESM entry: ${name}`)
    }
    return {
      find: new RegExp(`^${name}$`),
      replacement: containedFile(
        versions[name].directory,
        resolve(versions[name].directory, versions[name].esm)
      )
    }
  }),
  {
    find: '@n1-dom-setup',
    replacement: containedFile(root, resolve(root, 'config/scripts/vitest-dom-setup.ts'))
  },
  ...(node.resolve?.alias || [])
]
const seams = [
  ...[
    'RichMarkdownEditor.tsx',
    'useRichMarkdownEditorInstance.ts',
    'useRichMarkdownProgrammaticSync.ts',
    'drag-selection-guard.ts',
    'rich-markdown-editor-config.ts',
    'rich-markdown-selection-flush.ts',
    'rich-markdown-search-focus.ts'
  ].map((file) => {
    const id = resolve(root, 'src/renderer/src/components/editor', file)
    return { id, canonical: containedFile(root, id), kind: 'production-selection' }
  }),
  ...[
    ...node.test.setupFiles,
    named,
    ...[
      'observer.setup.mjs',
      'retained/adversarial.ts',
      'retained/lifetime.ts',
      'retained/editor-surface.ts',
      'retained/mapping-contracts.ts',
      'retained/release-contracts.ts',
      'retained/focus-contracts.ts'
    ].map((file) => resolve(packet, file))
  ].map((file) => {
    const id = resolve(root, file)
    return { id, canonical: containedFile(root, id), kind: 'fixture-setup' }
  }),
  ...provenance.map((entry) => ({
    id: entry.selectedFile,
    canonical: entry.canonicalSelectedFile,
    package: entry.name,
    kind: 'proved-dependency-entry'
  })),
  ...dependencySourceReceipts.map((entry) => ({
    id: entry.installed,
    canonical: entry.installed,
    package: entry.name,
    kind: 'proved-dependency-source'
  })),
  {
    id: engineId,
    canonical: containedFile(packet, resolve(packet, 'engine/observed-index.source')),
    kind: 'logging-only-engine-overlay'
  }
]
const { overlay } = createModuleObservation({
  root,
  output,
  seams,
  engineId,
  protocolMap,
  source,
  sha
})
const variants = Object.keys(protocolMap).map((protocol, index) => ({
  ...node,
  plugins: [overlay(protocol), ...(node.plugins || [])],
  resolve: { ...node.resolve, alias: aliases },
  test: {
    ...node.test,
    name: `n1-${protocol}`,
    include: [...node.test.include, named],
    setupFiles: [...node.test.setupFiles, resolve(packet, 'observer.setup.mjs')],
    env: { ...node.test.env, PR35764_N1_PROTOCOL: protocol, PR35764_N1_OUTPUT: output },
    server: {
      ...node.test.server,
      deps: {
        ...node.test.server?.deps,
        inline: [...(node.test.server?.deps?.inline || []), /^@tiptap\//, /^prosemirror-/]
      }
    },
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
    sequence: { ...node.test.sequence, groupOrder: index + 1 }
  }
}))
writeRuntimeReceipt({
  output,
  head,
  pins,
  versions,
  root,
  canonicalRoot,
  nodeModules,
  metadataFile,
  metadataBytes,
  metadataReceipt,
  virtualStoreLogical,
  virtualStore,
  generatedLockReceipt,
  sourceConfigPins,
  provenance,
  seamReceipts,
  cli,
  toolEsmURL,
  patchPath,
  patchBytes,
  patchTarget,
  patchTargetBytes,
  installedView,
  packet,
  named,
  protocolMap,
  source,
  node,
  base,
  sha
})
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    maxWorkers: 1,
    fileParallelism: false,
    projects: [...variants, ...base.test.projects.filter((p) => p !== node)]
  }
})
