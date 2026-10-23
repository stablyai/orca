import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { format } from 'oxfmt'
import { listTrackedFiles } from '../../../config/scripts/ratchet-baseline.mjs'
import { collectModuleSpecifiers } from '../../../config/scripts/static-module-specifiers.mjs'
import { isTestOnlySourcePath } from '../../../config/scripts/test-only-source-path.mjs'
import {
  createWorkspaceSourceResolver,
  workspacePackageManifests
} from '../../../config/scripts/workspace-source-exports.mjs'

const auditDirectory = import.meta.dirname
const root = path.resolve(auditDirectory, '../../..')
const plan = JSON.parse(readFileSync(path.join(auditDirectory, 'audit-plan.json'), 'utf8'))
const output = path.join(auditDirectory, 'codebase-map.json')
const check = process.argv.includes('--check')
const savedHead =
  check && existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).snapshot?.gitHead : null
if (
  check &&
  (typeof savedHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(savedHead))
) {
  throw new Error(
    'codebase-map.json is missing valid snapshot provenance; run this script without --check'
  )
}
const jsPattern = /\.[cm]?[jt]sx?$/
const nativePattern = /\.(?:swift|kt|kts|java|rs|c|cc|cpp|h|hpp|m|mm|py|sh|ps1|cmd|bat)$/
const generatedPattern = /(?:^|\/)generated\/|\.generated\.[^.]+$/
const tracked = listTrackedFiles(root, []).filter(
  (file) => !file.startsWith('docs/audits/module-organization/')
)
const files = tracked.filter((file) => existsSync(path.join(root, file))).sort()
const allFiles = new Set(files)
const caseFoldedFiles = new Set(files.map((file) => file.toLowerCase()))
const sources = files.filter((file) => jsPattern.test(file))
const sourceSet = new Set(sources)
const areas = [...plan.areas].sort((a, b) => b.path.length - a.path.length)
const areaOf = (file) =>
  areas.find((area) => area.path === '.' || file.startsWith(`${area.path}/`)).id
const isProduction = (file) => !isTestOnlySourcePath(file) && !generatedPattern.test(file)
const directories = new Map()
const familyMembers = new Map()
const digest = createHash('sha256')
const edges = new Map()
const reverse = new Map()
const unresolved = []
const parseFailures = []
const importStats = { specifiers: 0, localCode: 0, localNonCode: 0, externalOrUnmodeled: 0 }
const workspace = createWorkspaceSourceResolver(root)
const workspaceNames = workspacePackageManifests(root).map(
  (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8')).name
)

function directoryRecord(directory) {
  if (!directories.has(directory)) {
    directories.set(directory, {
      path: directory,
      area: areaOf(`${directory}/_`),
      directTrackedFiles: 0,
      recursiveTrackedFiles: 0,
      directJsTs: 0,
      directProductionJsTs: 0,
      directTestSupportJsTs: 0,
      directGeneratedJsTs: 0,
      recursiveJsTs: 0,
      recursiveNativeOrShell: 0,
      longestCodeBasename: null,
      longestCodeBasenameCharacters: 0
    })
  }
  return directories.get(directory)
}

function familyTokens(file) {
  return path.posix
    .basename(file)
    .replace(jsPattern, '')
    .split('.')[0]
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/^use-/, '')
    .split('-')
}

for (const file of files) {
  const parent = path.posix.dirname(file)
  const direct = directoryRecord(parent)
  direct.directTrackedFiles++
  const js = jsPattern.test(file)
  if (js) {
    direct.directJsTs++
    if (generatedPattern.test(file)) {
      direct.directGeneratedJsTs++
    } else if (isTestOnlySourcePath(file)) {
      direct.directTestSupportJsTs++
    } else {
      direct.directProductionJsTs++
    }
    const basename = path.posix.basename(file)
    if (basename.length > direct.longestCodeBasenameCharacters) {
      direct.longestCodeBasename = basename
      direct.longestCodeBasenameCharacters = basename.length
    }
    const tokens = familyTokens(file)
    for (let n = 1; n <= Math.min(3, tokens.length - 1); n++) {
      const prefix = tokens.slice(0, n).join('-')
      const key = `${parent}/${prefix}`
      if (!familyMembers.has(key)) {
        familyMembers.set(key, { directory: parent, prefix, files: [] })
      }
      familyMembers.get(key).files.push(file)
    }
  }
  for (let directory = parent; ; directory = path.posix.dirname(directory)) {
    const record = directoryRecord(directory)
    record.recursiveTrackedFiles++
    if (js) {
      record.recursiveJsTs++
    }
    if (nativePattern.test(file)) {
      record.recursiveNativeOrShell++
    }
    if (directory === '.') {
      break
    }
  }
}

function resolveLocal(file, specifier) {
  let target = null
  if (specifier.startsWith('.')) {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  } else if (specifier.startsWith('@renderer/')) {
    target = `src/renderer/src/${specifier.slice(10)}`
  } else if (specifier.startsWith('@/')) {
    const aliasRoot = file.startsWith('mobile/')
      ? 'mobile/src'
      : file.startsWith('docs/site/')
        ? 'docs/site/src'
        : 'src/renderer/src'
    target = `${aliasRoot}/${specifier.slice(2)}`
  } else if (
    workspaceNames.some((name) => specifier === name || specifier.startsWith(`${name}/`))
  ) {
    try {
      target = workspace.resolve(specifier)?.file ?? null
    } catch {
      return { kind: 'unresolved', specifier }
    }
  }
  if (target === null) {
    return { kind: 'externalOrUnmodeled' }
  }
  target = target.split('?')[0]
  const stems = [target]
  if (/\.[cm]?js$/.test(target)) {
    stems.push(target.replace(/\.[cm]?js$/, ''))
  }
  for (const stem of stems) {
    for (const extension of [
      '',
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.mjs',
      '.cjs',
      '.jsx',
      '.json',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.mjs',
      '/index.cjs'
    ]) {
      const candidate = stem + extension
      if (allFiles.has(candidate)) {
        return { kind: sourceSet.has(candidate) ? 'localCode' : 'localNonCode', target: candidate }
      }
    }
  }
  return { kind: 'unresolved', specifier }
}

for (const file of sources) {
  const contents = readFileSync(path.join(root, file), 'utf8')
  digest.update(file).update('\0').update(contents).update('\0')
  let specifiers
  try {
    specifiers = collectModuleSpecifiers(file, contents)
  } catch (error) {
    parseFailures.push({ file, error: error.message })
    continue
  }
  const dependencies = new Set()
  for (const specifier of specifiers) {
    importStats.specifiers++
    const resolution = resolveLocal(file, specifier)
    if (resolution.kind === 'unresolved') {
      unresolved.push({ file, specifier })
    } else {
      importStats[resolution.kind]++
    }
    if (resolution.kind !== 'localCode') {
      continue
    }
    dependencies.add(resolution.target)
    if (!reverse.has(resolution.target)) {
      reverse.set(resolution.target, new Set())
    }
    reverse.get(resolution.target).add(file)
  }
  edges.set(file, dependencies)
}

function counted(values) {
  const counts = new Map()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
}

function proposalDetails(proposal) {
  const pattern = new RegExp(proposal.basenamePattern)
  const selected = sources.filter(
    (file) =>
      path.posix.dirname(file) === proposal.directory && pattern.test(path.posix.basename(file))
  )
  if (!selected.length) {
    throw new Error(`Empty proposal: ${proposal.id}`)
  }
  const selectedSet = new Set(selected)
  const importers = new Set()
  const dependencies = new Set()
  let internalEdges = 0
  let inboundEdges = 0
  let outboundEdges = 0
  let productionInboundEdges = 0
  let productionInternalEdges = 0
  let productionOutboundEdges = 0
  const moves = selected.map((file) => {
    const basename = path.posix.basename(file)
    let renamed = basename
    if (proposal.entryStem && basename.startsWith(`${proposal.entryStem}.`)) {
      renamed = proposal.targetEntryStem + basename.slice(proposal.entryStem.length)
    } else if (proposal.stripPrefix && basename.startsWith(proposal.stripPrefix)) {
      renamed = basename.slice(proposal.stripPrefix.length)
    }
    const route = proposal.routes?.find((route) => new RegExp(route.basenamePattern).test(basename))
    const to = `${route?.targetDirectory ?? proposal.targetDirectory}/${renamed}`
    for (const importer of reverse.get(file) ?? []) {
      if (!selectedSet.has(importer)) {
        importers.add(importer)
        inboundEdges++
        if (isProduction(importer)) {
          productionInboundEdges++
        }
      }
    }
    for (const dependency of edges.get(file) ?? []) {
      if (selectedSet.has(dependency)) {
        internalEdges++
        if (isProduction(file)) {
          productionInternalEdges++
        }
      } else {
        dependencies.add(dependency)
        outboundEdges++
        if (isProduction(file)) {
          productionOutboundEdges++
        }
      }
    }
    return {
      from: file,
      to,
      testSupport: isTestOnlySourcePath(file),
      targetExists: allFiles.has(to),
      targetCaseInsensitiveExists: caseFoldedFiles.has(to.toLowerCase())
    }
  })
  const destinations = new Set(moves.map((move) => move.to.toLowerCase()))
  if (destinations.size !== moves.length) {
    throw new Error(`Duplicate destination: ${proposal.id}`)
  }
  return {
    ...proposal,
    status: 'proposed-not-applied',
    selectedFiles: selected.length,
    productionFiles: selected.filter(isProduction).length,
    testSupportFiles: selected.filter(isTestOnlySourcePath).length,
    existingTargetJsTs: directories.get(proposal.targetDirectory)?.recursiveJsTs ?? 0,
    collisionCount: moves.filter((move) => move.targetCaseInsensitiveExists).length,
    dependencyBoundary: {
      internalEdges,
      inboundEdges,
      outboundEdges,
      productionInternalEdges,
      productionInboundEdges,
      productionOutboundEdges,
      externalImporterFiles: [...importers].sort(),
      productionExternalImporterFiles: [...importers].filter(isProduction).sort(),
      outboundDependencyDirectories: counted(
        [...dependencies].map((file) => path.posix.dirname(file))
      ),
      unresolvedSpecifiers: unresolved.filter(({ file }) => selectedSet.has(file))
    },
    moves
  }
}

const proposals = plan.proposals.map(proposalDetails)
const selectedBy = new Map()
for (const proposal of proposals) {
  for (const { from } of proposal.moves) {
    if (selectedBy.has(from)) {
      throw new Error(`Overlapping proposals: ${from}`)
    }
    selectedBy.set(from, proposal.id)
  }
}
const areaEdges = []
for (const [file, dependencies] of edges) {
  if (!isProduction(file)) {
    continue
  }
  for (const dependency of dependencies) {
    if (areaOf(file) !== areaOf(dependency)) {
      areaEdges.push(`${areaOf(file)} -> ${areaOf(dependency)}`)
    }
  }
}
const families = [...familyMembers.values()]
  .map(({ directory, prefix, files }) => ({
    directory,
    prefix,
    files: files.length,
    productionFiles: files.filter(isProduction).length,
    examples: files.filter(isProduction).slice(0, 3)
  }))
  .filter((family) => family.files >= 8 && family.productionFiles >= 3)
  .sort(
    (a, b) =>
      b.files - a.files || `${a.directory}/${a.prefix}`.localeCompare(`${b.directory}/${b.prefix}`)
  )

const result = {
  schemaVersion: 1,
  snapshot: {
    gitHead:
      savedHead ??
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    jsTsContentSha256: digest.digest('hex'),
    inventory:
      'Git-tracked paths with current working-tree contents; this audit directory excluded',
    missingTrackedPaths: tracked.filter((file) => !allFiles.has(file)),
    trackedFiles: files.length,
    jsTsFiles: sources.length,
    productionJsTsFiles: sources.filter(isProduction).length,
    testSupportJsTsFiles: sources.filter(isTestOnlySourcePath).length,
    generatedJsTsFiles: sources.filter((file) => generatedPattern.test(file)).length,
    nativeOrShellFiles: files.filter((file) => nativePattern.test(file)).length
  },
  methodology: {
    directoryCounts:
      'Direct and recursive counts include tracked test/support and generated files, with direct JS/TS breakdowns. Counts are files, not lines or runtime complexity.',
    production:
      'JS/TS not identified by the existing test-only-source-path policy or generated filename/directory convention. This includes tooling and declarations; it does not mean shipped product code.',
    families:
      'Overlapping discovery signals, not move recommendations. Kebab/Pascal/camel normalized; use- removed; first 1-3 tokens, with at least one remaining token; >=8 files and >=3 production-classified files. Do not sum families.',
    imports:
      'Existing collectModuleSpecifiers AST parser reused. Includes type imports, re-exports and recognized literal/const-string module loaders. Deduplicated directed file pairs for graph counts; inbound/outbound are direct, not transitive.',
    resolution:
      'Relative tracked paths, index modules, JS-to-TS source counterparts, @renderer/, context-aware @/ and root workspace orca-source exports. Exact non-code paths counted separately. Other bare packages/aliases not modeled.',
    limitations:
      'No call graph, runtime dependency proof or behavioral audit. Computed paths, new URL, filesystem reads, worker/spawn strings, package scripts and CI references are outside the import graph. Unresolved inputs and parser failures are explicit. Native/shell code is inventoried but imports are not analyzed.',
    proposals:
      'Human-reviewed candidate ownership scopes. Exact path suggestions and collision checks are supplied; broad proposals require smaller PRs and deeper semantic review. Basenames retained unless explicit stripPrefix/entryStem rules apply.'
  },
  areas: plan.areas.map((area) => ({
    ...area,
    exclusiveTrackedFiles: files.filter((file) => areaOf(file) === area.id).length,
    exclusiveJsTsFiles: sources.filter((file) => areaOf(file) === area.id).length
  })),
  featureTrails: plan.featureTrails,
  directories: [...directories.values()].sort((a, b) => a.path.localeCompare(b.path)),
  prefixFamilies: families,
  productionAreaImportEdges: counted(areaEdges).map(({ path: edge, count }) => ({ edge, count })),
  importAnalysis: { ...importStats, unresolvedCount: unresolved.length, unresolved, parseFailures },
  proposals
}
const formatted = await format(
  output,
  `${JSON.stringify(result, null, 2)}\n`,
  JSON.parse(readFileSync(path.join(root, '.oxfmtrc.json'), 'utf8'))
)
if (formatted.errors.length > 0) {
  throw new Error(`Cannot format codebase map: ${JSON.stringify(formatted.errors)}`)
}
const serialized = formatted.code
if (check) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== serialized) {
    throw new Error('codebase-map.json is stale; run this script without --check')
  }
  console.log(`Verified ${sources.length} JS/TS files and ${proposals.length} proposals`)
} else {
  writeFileSync(output, serialized)
  console.log(
    `Wrote ${output}: ${sources.length} JS/TS files, ${directories.size} directories, ${proposals.length} proposals`
  )
}
