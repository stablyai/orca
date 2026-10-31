import {
  readlinkSync,
  realpathSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync
} from 'node:fs'
import { dirname, resolve, relative, isAbsolute, parse, sep, basename } from 'node:path'

export function within(parent, child) {
  const rel = relative(parent, child)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
export function same(a, b) {
  return relative(a, b) === ''
}
export function containedFile(parent, path) {
  if (!within(parent, resolve(path))) {
    throw new Error(`R4 logical source escape: ${path}`)
  }
  const physical = realpathSync(path)
  if (!within(realpathSync(parent), physical)) {
    throw new Error(`R4 canonical source escape: ${path}`)
  }
  return physical
}
export function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}
export function links(path, seen = new Set(), depth = 0) {
  if (depth > 32) {
    throw new Error('N1 link chain exceeds bounded provenance inspection')
  }
  const absolute = resolve(path),
    parts = relative(parse(absolute).root, absolute).split(sep)
  let at = parse(absolute).root
  const result = []
  for (const part of parts) {
    at = resolve(at, part)
    if (seen.has(at)) {
      continue
    }
    seen.add(at)
    if (lstatSync(at).isSymbolicLink()) {
      const target = readlinkSync(at)
      result.push({ logical: at, target, canonical: realpathSync(at) })
      result.push(...links(resolve(dirname(at), target), seen, depth + 1))
    }
  }
  return result
}
// Frozen block-lock slices stay byte-attributed; generated metadata uses the locked YAML parser.
export function scalar(text) {
  if (text === undefined) {
    throw new Error('N1 missing explicit metadata scalar')
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) {
      throw new Error('N1 unsupported quoted metadata')
    }
    return text.slice(1, -1).replaceAll("''", "'")
  }
  if (text.startsWith('"')) {
    return JSON.parse(text)
  }
  if (!text || /[\n\r]|^(?:[&*!|>{[])/.test(text) || /\s#/.test(text)) {
    throw new Error('N1 unsupported relevant metadata scalar: return actual source gap')
  }
  return text
}
export function fields(text, indent) {
  const lines = text.split('\n'),
    found = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#') || line.search(/\S/) !== indent) {
      continue
    }
    const entry = line.slice(indent)
    const match =
      entry.startsWith("'") || entry.startsWith('"')
        ? entry.match(/^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")[ \t]*:(?:[ \t]+(.*))?$/)
        : entry.match(/^((?:[^:]|:(?![ \t]|$))+?)[ \t]*:(?:[ \t]+(.*))?$/)
    if (!match) {
      throw new Error(`N1 unsupported relevant mapping: ${line}`)
    }
    let end = i + 1
    while (
      end < lines.length &&
      (!lines[end].trim() ||
        lines[end].trimStart().startsWith('#') ||
        lines[end].search(/\S/) > indent)
    ) {
      end++
    }
    const key = scalar(match[1].trimEnd())
    if (found.some((x) => x.key === key)) {
      throw new Error(`N1 duplicate relevant metadata key: ${key}`)
    }
    found.push({
      key,
      value: match[2],
      text: lines.slice(i, end).join('\n'),
      children: lines.slice(i + 1, end).join('\n')
    })
  }
  return found
}
export function field(text, indent, key, required = true) {
  const item = fields(text, indent).find((x) => x.key === key)
  if (!item && required) {
    throw new Error(`N1 missing actual generated/lock mapping: ${key}`)
  }
  return item
}

function parserFromOwnInstall({ root, nodeModules, require, lockDocument, sha }) {
  const importer = field(field(lockDocument, 0, 'importers').children, 2, '.').children
  const dependencies = field(importer, 4, 'dependencies').children
  const locked = field(dependencies, 6, 'yaml')
  const version = scalar(field(locked.children, 8, 'version').value)
  const snapshot = field(field(lockDocument, 0, 'snapshots').children, 2, `yaml@${version}`)
  if (version !== '2.9.1' || snapshot.value !== '{}' || snapshot.children.trim()) {
    throw new Error('R4 parser bootstrap needs the frozen dependency-free yaml snapshot')
  }
  const candidates = require.resolve.paths('yaml').map((path) => resolve(path, 'yaml'))
  const logical = candidates.find(exists)
  if (!logical || !same(logical, resolve(nodeModules, 'yaml'))) {
    throw new Error('R4 parser bootstrap refuses a first-existing foreign/ancestor entry')
  }
  const directory = realpathSync(logical)
  if (!within(realpathSync(nodeModules), directory)) {
    throw new Error('R4 parser bootstrap must remain in this own fresh CI installation')
  }
  const chain = links(logical)
  const packageFile = containedFile(directory, resolve(directory, 'package.json'))
  const packageBytes = readFileSync(packageFile)
  const json = JSON.parse(packageBytes.toString('utf8'))
  const selected = realpathSync(require.resolve('yaml'))
  if (
    !chain.length ||
    json.name !== 'yaml' ||
    json.version !== version ||
    typeof json.main !== 'string' ||
    isAbsolute(json.main) ||
    !same(selected, containedFile(directory, resolve(directory, json.main)))
  ) {
    throw new Error('R4 parser bootstrap selected source differs from the frozen own package')
  }
  const slotModules = dirname(directory)
  const slot = dirname(slotModules)
  const store = dirname(slot)
  if (
    basename(slotModules) !== 'node_modules' ||
    basename(slot) !== `yaml@${version}` ||
    !within(realpathSync(nodeModules), store)
  ) {
    throw new Error('R4 parser bootstrap has no own locked slot/store attribution')
  }
  return {
    selected,
    directory,
    store,
    logical,
    linkCount: chain.length,
    linksSha256: sha(JSON.stringify(chain)),
    version,
    packageJsonSha256: sha(packageBytes),
    sourceSha256: sha(readFileSync(selected)),
    root: realpathSync(root),
    rootImporterSha256: sha(locked.text),
    snapshotSha256: sha(snapshot.text),
    lookupCandidatesBeforeSelected: candidates.slice(0, candidates.indexOf(logical)),
    selection: 'original config createRequire; first existing own link; frozen root edge/slot',
    fullMetadataRouteVerification: 'pending after decoding; no default virtual store'
  }
}

export function readInstallationMetadata({
  root,
  nodeModules,
  metadataFile,
  output,
  require,
  lockDocument,
  sha
}) {
  const cap = 16 * 1024 * 1024
  const buffer = Buffer.alloc(cap + 1)
  const context = {
    logical: resolve(nodeModules, '.modules.yaml'),
    canonical: metadataFile,
    rawFile: 'installation-metadata.raw',
    cap,
    reads: 0,
    receivedBytes: 0,
    eof: false,
    incomplete: true,
    requestedKey: '<document>',
    consumedRootKeys: [
      'virtualStoreDir',
      'hoistedDependencies',
      'nodeLinker',
      'packageManager',
      'layoutVersion'
    ],
    stage: 'before-read',
    error: null,
    priorRuns: ['41157454166', '41179615237'],
    continuationOrdinal: 3
  }
  const receiptFile = resolve(output, 'installation-metadata-receipt.json')
  const persist = (exclusive = false) => {
    const bytes = Buffer.from(JSON.stringify(context, null, 2))
    if (bytes.length > 16 * 1024) {
      throw new Error('R4 installation-metadata receipt overflow')
    }
    writeFileSync(receiptFile, bytes, exclusive ? { flag: 'wx' } : undefined)
  }
  persist(true)
  let fd,
    readError = null
  try {
    fd = openSync(metadataFile, 'r')
    while (context.reads < 257 && context.receivedBytes < buffer.length) {
      const take = Math.min(64 * 1024, buffer.length - context.receivedBytes)
      const count = readSync(fd, buffer, context.receivedBytes, take, null)
      context.reads++
      if (!count) {
        context.eof = true
        break
      }
      context.receivedBytes += count
    }
  } catch (error) {
    readError = error
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch (error) {
        readError = error
      }
    }
  }
  const metadataBytes = buffer.subarray(0, Math.min(context.receivedBytes, cap))
  writeFileSync(resolve(output, context.rawFile), metadataBytes, { flag: 'wx' })
  context.bytes = metadataBytes.length
  context.sha256 = sha(metadataBytes)
  context.incomplete = Boolean(readError || !context.eof || context.receivedBytes > cap)
  context.stage = 'raw-persisted-before-decode'
  context.error = readError
    ? {
        name: 'read-or-close-failure',
        code: typeof readError.code === 'string' ? readError.code.slice(0, 64) : null
      }
    : null
  persist()
  if (context.incomplete) {
    throw new Error('R4 generated metadata read incomplete/excess/failure; raw prefix retained')
  }
  const requested = (key) => {
    context.requestedKey = key.slice(0, 512)
  }
  try {
    context.stage = 'parser-bootstrap'
    context.parser = parserFromOwnInstall({ root, nodeModules, require, lockDocument, sha })
    persist()
    const yaml = require(context.parser.selected)
    if (['parseDocument', 'isMap', 'isScalar'].some((key) => typeof yaml[key] !== 'function')) {
      throw new Error('R4 locked parser lacks the required mapping interface')
    }
    context.stage = 'decode'
    const metadata = metadataBytes.toString('utf8')
    if (!Buffer.from(metadata, 'utf8').equals(metadataBytes)) {
      throw new Error('R4 generated metadata is not complete valid UTF-8')
    }
    const document = yaml.parseDocument(metadata, {
      keepSourceTokens: false,
      merge: false,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    const problems = [...document.errors, ...document.warnings]
    if (problems.length) {
      context.problems = problems.slice(0, 8).map((problem) => ({
        code: typeof problem.code === 'string' ? problem.code.slice(0, 64) : null,
        pos: Array.isArray(problem.pos) ? problem.pos.slice(0, 2).filter(Number.isFinite) : null
      }))
      throw new Error('R4 generated metadata parse errors/warnings; raw original retained')
    }
    context.stage = 'validate-consumed-fields'
    const mapping = (node, key) => {
      requested(key)
      if (!yaml.isMap(node)) {
        throw new Error('R4 consumed metadata requires a mapping')
      }
      const result = new Map()
      for (const pair of node.items) {
        if (
          !yaml.isScalar(pair.key) ||
          typeof pair.key.value !== 'string' ||
          !pair.key.value ||
          pair.key.value.length > 4096
        ) {
          throw new Error('R4 consumed mapping requires bounded nonempty string keys')
        }
        const name = pair.key.value
        if (name === '<<' || result.has(name)) {
          throw new Error('R4 duplicate/merged/ambiguous metadata mapping refused')
        }
        result.set(name, pair.value)
      }
      return result
    }
    const string = (node, key) => {
      requested(key)
      if (
        !yaml.isScalar(node) ||
        typeof node.value !== 'string' ||
        !node.value ||
        node.value.length > 4096
      ) {
        throw new Error('R4 consumed metadata requires a bounded nonempty string')
      }
      return node.value
    }
    const rootFields = mapping(document.contents, '<root>')
    const virtualStoreDir = string(rootFields.get('virtualStoreDir'), 'virtualStoreDir')
    const hoistedDependencies = new Map()
    for (const [key, node] of mapping(
      rootFields.get('hoistedDependencies'),
      'hoistedDependencies'
    )) {
      const names = new Map()
      for (const [name, value] of mapping(node, `hoistedDependencies.${key}`)) {
        const visibility = string(value, `hoistedDependencies.${key}.${name}`)
        if (!['public', 'private'].includes(visibility)) {
          throw new Error('R4 generated hoist visibility must be public/private')
        }
        names.set(name, visibility)
      }
      hoistedDependencies.set(key, names)
    }
    const observed = {}
    for (const key of ['nodeLinker', 'packageManager', 'layoutVersion']) {
      requested(key)
      if (!rootFields.has(key)) {
        observed[key] = { present: false }
        continue
      }
      const node = rootFields.get(key)
      if (key === 'layoutVersion') {
        if (!yaml.isScalar(node) || !Number.isSafeInteger(node.value) || node.value < 0) {
          throw new Error('R4 observed layoutVersion must be a nonnegative integer')
        }
        observed[key] = { present: true, value: node.value }
      } else {
        observed[key] = { present: true, value: string(node, key) }
      }
    }
    requested('virtualStoreDir/parser-bootstrap-corroboration')
    if (!same(realpathSync(resolve(nodeModules, virtualStoreDir)), context.parser.store)) {
      throw new Error('R4 decoded actual virtual store differs from the selected parser slot')
    }
    context.stage = 'decoded-and-typed'
    context.requestedKey = null
    context.decoded = { virtualStoreDir, hoistedPackageCount: hoistedDependencies.size, observed }
    persist()
    return {
      metadataBytes,
      metadata: metadataBytes.toString('utf8'),
      virtualStoreDir,
      hoistedDependencies,
      metadataReceipt: context,
      verifyParserRoute(resolveInfo) {
        context.stage = 'verify-parser-full-provenance'
        requested('yaml/own-edge-link-generated-snapshot')
        persist()
        try {
          const info = resolveInfo()
          if (
            !same(info.directory, context.parser.directory) ||
            !same(info.selected, context.parser.selected)
          ) {
            throw new Error('R4 decoded full parser provenance differs from bootstrap source')
          }
          context.parser.fullMetadataRouteVerification =
            'verified by original own edge/link/snapshot proof'
          context.stage = 'decoded-and-parser-route-verified'
          context.requestedKey = null
          persist()
        } catch (error) {
          context.error = {
            name: error instanceof Error ? error.name.slice(0, 64) : 'unknown',
            message: error instanceof Error ? error.message.slice(0, 512) : null
          }
          context.incomplete = true
          persist()
          throw error
        }
      }
    }
  } catch (error) {
    context.error = {
      name: error instanceof Error ? error.name.slice(0, 64) : 'unknown',
      message: error instanceof Error ? error.message.slice(0, 512) : null
    }
    context.incomplete = true
    persist()
    throw error
  }
}
