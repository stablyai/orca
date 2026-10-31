import { readFileSync, writeFileSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { containedFile, exists, within, same } from './installation-metadata.mjs'

export function createModuleObservation({
  root,
  canonicalRoot,
  output,
  proven,
  engineId,
  protocolMap,
  source,
  sha
}) {
  const editor = '/src/renderer/src/components/editor/'
  const moduleReceipts = [],
    moduleReceiptKeys = new Set()
  function moduleReceipt(id, code, protocol, stage) {
    const filename = id.split('?')[0]
    const relevant =
      /(?:prosemirror-|@tiptap|react|vitest|vite|happy-dom|pr35764-n1|components[\\/]editor)/.test(
        id
      )
    let physical,
      info,
      local = false
    if (isAbsolute(filename) && exists(filename) && lstatSync(filename).isFile()) {
      physical = realpathSync(filename)
      info = [...proven.values()].find((p) => within(p.directory, physical))
      local = within(canonicalRoot, physical)
    }
    if (!info && !local && !relevant) {
      return
    }
    const key = `${protocol}:${stage}:${id}`
    if (moduleReceiptKeys.has(key)) {
      return
    }
    if (moduleReceipts.length >= 2000) {
      throw new Error('N1 config-only loader receipt overflow; return incomplete')
    }
    moduleReceiptKeys.add(key)
    moduleReceipts.push({
      protocol,
      stage,
      id,
      canonical: info || local ? physical : null,
      package: info?.name,
      sourceReadableThroughProvenRoute: Boolean(info || local),
      sourceSha256: info || local ? sha(readFileSync(physical)) : null,
      transformedSha256: code === undefined ? undefined : sha(code)
    })
    writeFileSync(
      resolve(output, 'loaded-module-receipts.json'),
      JSON.stringify(
        {
          limit: 2000,
          idsAreNotExecutionProof: true,
          externalizedModulesMayBeAbsent: true,
          modules: moduleReceipts
        },
        null,
        2
      )
    )
  }

  function ownOverlay(id, filename) {
    const selected = id.split('?')[0],
      expected = resolve(root, 'src/renderer/src/components/editor', filename)
    const canonicalExpected = containedFile(root, expected)
    if (
      (!same(resolve(selected), expected) && !same(resolve(selected), canonicalExpected)) ||
      !same(realpathSync(selected), canonicalExpected)
    ) {
      throw new Error(`N1 overlay matched a shadow/foreign module: ${id}`)
    }
  }

  const normal = (path) => path.split('?')[0].replaceAll('\\', '/')
  function overlay(protocol) {
    return {
      name: `private-n1-${protocol}`,
      enforce: 'pre',
      resolveId(id) {
        if (id === engineId) {
          return engineId
        }
      },
      transform(code, id) {
        moduleReceipt(id, code, protocol, 'transform')
        return null
      },
      load(id) {
        if (id.split('?')[0] === engineId) {
          return source('engine/observed-index.source')
        }
        moduleReceipt(id, undefined, protocol, 'load')
        const path = normal(id)
        if (path.endsWith(`${editor}drag-selection-guard.ts`)) {
          ownOverlay(id, 'drag-selection-guard.ts')
          writeFileSync(
            resolve(output, `loaded-${protocol}-guard.json`),
            JSON.stringify(
              { id, source: protocolMap[protocol], sha256: sha(source(protocolMap[protocol])) },
              null,
              2
            )
          )
          return source(protocolMap[protocol])
        }
        if (protocol === 'main' && path.endsWith(`${editor}rich-markdown-editor-config.ts`)) {
          ownOverlay(id, 'rich-markdown-editor-config.ts')
          return source('source/main-rich-markdown-editor-config.source')
        }
        if (protocol === 'main' && path.endsWith(`${editor}rich-markdown-selection-flush.ts`)) {
          ownOverlay(id, 'rich-markdown-selection-flush.ts')
          return source('source/main-rich-markdown-selection-flush.source')
        }
        return null
      }
    }
  }
  return { overlay }
}

export function writeRuntimeReceipt({
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
}) {
  writeFileSync(
    resolve(output, 'runtime-receipt.json'),
    JSON.stringify(
      {
        head,
        productionHead: pins.productionHead,
        mainSelectionRouteHead: pins.mainSelectionRouteHead,
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        processStartedApprox: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        versions,
        dependencyProvenance: {
          root: { logical: root, canonical: canonicalRoot },
          nodeModules: { logical: nodeModules, canonical: realpathSync(nodeModules) },
          metadata: {
            logical: resolve(nodeModules, '.modules.yaml'),
            canonical: metadataFile,
            sha256: sha(metadataBytes),
            rawFile: metadataReceipt.rawFile,
            decodedFields: metadataReceipt.decoded,
            parserBootstrap: metadataReceipt.parser,
            receiptFile: 'installation-metadata-receipt.json'
          },
          virtualStore: { logical: virtualStoreLogical, canonical: virtualStore },
          generatedLock: generatedLockReceipt,
          sourceConfigPins,
          routes: provenance,
          selectedPackageSeams: seamReceipts,
          cli: { path: cli, sha256: sha(readFileSync(cli)), esmConfigURL: toolEsmURL },
          vitestPatch: {
            path: patchPath,
            sha256: sha(patchBytes),
            target: patchTarget,
            targetSha256: sha(patchTargetBytes)
          },
          overridePresence: {
            nodePath: Boolean(process.env.NODE_PATH),
            nodeOptions: Boolean(process.env.NODE_OPTIONS)
          },
          configStaticImportsPrecedeChecks: true,
          resolutionReceiptsAreNotRuntimeLoadProof: true
        },
        engineOriginal: sha(installedView),
        engineObserved: sha(readFileSync(resolve(packet, 'engine/observed-index.source'))),
        named,
        protocolMap,
        overlaySources: Object.fromEntries(
          [
            ...Object.values(protocolMap),
            'vitest.config.mjs',
            'run-once.mjs',
            'observer.setup.mjs',
            'n1-acceptance-contract.test.tsx',
            'retained/adversarial.ts',
            'retained/lifetime.ts',
            'installation-metadata.mjs',
            'package-resolution.mjs',
            'module-observation.mjs',
            'retained/editor-surface.ts',
            'retained/mapping-contracts.ts',
            'retained/release-contracts.ts',
            'retained/focus-contracts.ts',
            'source/main-rich-markdown-editor-config.source',
            'source/main-rich-markdown-selection-flush.source',
            'engine/logging-only.diff',
            'engine/observed-index.source'
          ].map((file) => [file, sha(source(file))])
        ),
        baseIncludes: node.test.include,
        baseSetup: node.test.setupFiles,
        baseAliases: node.resolve.alias,
        projectNames: base.test.projects.map((p) => p.test.name),
        preservedOtherProjects: base.test.projects
          .filter((p) => p !== node)
          .map((p) => p.test.name),
        syntheticMainSelectionRouteOnly: true,
        noFunctionalRelease: true
      },
      null,
      2
    )
  )
}
