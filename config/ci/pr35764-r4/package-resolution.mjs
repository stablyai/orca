import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import {
  within,
  same,
  containedFile,
  exists,
  links,
  scalar,
  fields,
  field
} from './installation-metadata.mjs'

export function createPackageResolution({ root, canonicalRoot, require, sha, configFilename }) {
  const lockText = readFileSync(containedFile(root, resolve(root, 'pnpm-lock.yaml')), 'utf8')
  const lockDocument = lockText.split(/^---\s*$/m).at(-1)
  const frozenSnapshots = field(lockDocument, 0, 'snapshots').children
  const importer = field(field(lockDocument, 0, 'importers').children, 2, '.').children
  const nodeModules = resolve(root, 'node_modules')
  if (!same(realpathSync(nodeModules), resolve(canonicalRoot, 'node_modules'))) {
    throw new Error('N1 refuses borrowed/relocated whole node_modules')
  }
  const metadataFile = containedFile(nodeModules, resolve(nodeModules, '.modules.yaml'))
  const metadataBytes = readFileSync(metadataFile),
    metadata = metadataBytes.toString('utf8')
  if (metadataBytes.length > 16 * 1024 * 1024) {
    throw new Error('N1 generated metadata exceeds bounded targeted inspection')
  }
  const virtualStoreLogical = resolve(
    nodeModules,
    scalar(field(metadata, 0, 'virtualStoreDir').value)
  )
  const virtualStore = realpathSync(virtualStoreLogical)
  const hoisted = field(metadata, 0, 'hoistedDependencies', false)?.children || ''
  const generatedLockPath = resolve(nodeModules, '.pnpm/lock.yaml')
  let generatedLock = null,
    generatedLockReceipt = null
  if (exists(generatedLockPath)) {
    const physical = realpathSync(generatedLockPath)
    if (!within(realpathSync(nodeModules), physical) && !within(virtualStore, physical)) {
      throw new Error('N1 generated lock does not follow the own installation metadata')
    }
    const bytes = readFileSync(physical)
    generatedLock = bytes
      .toString('utf8')
      .split(/^---\s*$/m)
      .at(-1)
    generatedLockReceipt = {
      logical: generatedLockPath,
      canonical: physical,
      links: links(generatedLockPath),
      sha256: sha(bytes)
    }
  }
  const provenance = [],
    proven = new Map()
  function snapshot(key, name, version) {
    if (key !== `${name}@${version}` && !key.startsWith(`${name}@${version}(`)) {
      throw new Error(`N1 lock identity does not match selected package: ${key}`)
    }
    const item = field(frozenSnapshots, 2, key)
    if (generatedLock) {
      const actual = field(field(generatedLock, 0, 'snapshots').children, 2, key)
      if (actual.text.replaceAll('\r', '').trim() !== item.text.replaceAll('\r', '').trim()) {
        throw new Error(`N1 generated snapshot differs from frozen lock: ${key}`)
      }
    }
    return item
  }
  function ownRootIdentity(name) {
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const section = field(importer, 4, group, false)
      const entry = section && field(section.children, 6, name, false)
      if (entry) {
        return {
          key: `${name}@${scalar(field(entry.children, 8, 'version').value)}`,
          kind: 'root-importer',
          evidence: entry.text
        }
      }
    }
    return hoistIdentity(name, 'public')
  }
  function hoistIdentity(name, visibility) {
    const matches = fields(hoisted, 2).filter((item) => {
      const nameEntry = field(item.children, 4, name, false)
      return nameEntry && scalar(nameEntry.value) === visibility
    })
    if (matches.length !== 1) {
      throw new Error(`N1 missing/ambiguous generated ${visibility} hoist edge: ${name}`)
    }
    return { key: matches[0].key, kind: `${visibility}-hoist`, evidence: matches[0].text }
  }
  function dependencyIdentity(origin, name) {
    for (const group of ['dependencies', 'optionalDependencies']) {
      const section = field(origin.snapshot.children, 4, group, false)
      const entry = section && field(section.children, 6, name, false)
      if (entry) {
        return {
          key: `${name}@${scalar(entry.value)}`,
          kind: 'locked-dependency-or-peer',
          evidence: entry.text
        }
      }
    }
    throw new Error(`N1 no frozen dependency/peer edge from ${origin.name} to ${name}`)
  }
  function packageAt(selected, name, boundary) {
    let directory = dirname(realpathSync(selected))
    while (true) {
      let bytes
      try {
        bytes = readFileSync(resolve(directory, 'package.json'))
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error
        }
      }
      if (bytes) {
        const json = JSON.parse(bytes.toString('utf8'))
        if (json.name && json.name !== name) {
          throw new Error(`N1 selected another package: ${selected}`)
        }
        if (json.name === name) {
          return { directory, json, packageJsonSha256: sha(bytes) }
        }
      }
      const parent = dirname(directory)
      if (same(directory, boundary) || !within(boundary, parent)) {
        throw new Error(`N1 cannot identify selected package inside proved entry: ${name}`)
      }
      directory = parent
    }
  }
  function entryIdentity(context, name, logical) {
    if (!context.origin) {
      if (!same(logical, resolve(nodeModules, name))) {
        throw new Error(`N1 packet/ancestor/global shadow route: ${logical}`)
      }
      return ownRootIdentity(name)
    }
    if (same(logical, resolve(context.origin.slotModules, name))) {
      return dependencyIdentity(context.origin, name)
    }
    if (same(logical, resolve(virtualStoreLogical, 'node_modules', name))) {
      const identity = hoistIdentity(name, 'private')
      if (identity.key !== dependencyIdentity(context.origin, name).key) {
        throw new Error('N1 hoist differs from the actual origin dependency/peer edge')
      }
      return identity
    }
    throw new Error(`N1 ancestor/NODE_PATH/foreign fallback from verified origin: ${logical}`)
  }
  function prove(context, specifier, selected) {
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]
    const lookup = context.resolver.resolve.paths(specifier)
    if (!lookup) {
      throw new Error('N1 expected a package resolution path')
    }
    const candidates = lookup.map((directory) => resolve(directory, name))
    const logical = candidates.find(exists)
    if (!logical) {
      throw new Error(`N1 no actual generated package entry: ${specifier}`)
    }
    const identity = entryIdentity(context, name, logical)
    const entryCanonical = realpathSync(logical),
      physicalFile = realpathSync(selected)
    if (!within(virtualStore, entryCanonical) || !within(entryCanonical, physicalFile)) {
      throw new Error(`N1 selected file bypasses actual generated installation entry: ${specifier}`)
    }
    const chain = links(logical)
    if (!chain.length) {
      throw new Error(
        `N1 package is not reached through its actual generated installation link: ${logical}`
      )
    }
    const found = packageAt(selected, name, entryCanonical)
    if (!same(entryCanonical, found.directory)) {
      throw new Error(`N1 selected package differs from proved entry: ${specifier}`)
    }
    const slotModules = resolve(found.directory, ...name.split('/').map(() => '..'))
    if (
      !same(resolve(slotModules, name), found.directory) ||
      !same(slotModules, resolve(dirname(slotModules), 'node_modules'))
    ) {
      throw new Error('N1 cannot prove generated package slot boundary')
    }
    const slot = dirname(slotModules)
    if (!within(virtualStore, slot) || same(virtualStore, slot)) {
      throw new Error('N1 package slot outside actual virtual store')
    }
    const item = snapshot(identity.key, name, found.json.version)
    const prior = proven.get(found.directory)
    if (prior && prior.snapshot.key !== item.key) {
      throw new Error('N1 same canonical slot has conflicting generated lock identities')
    }
    const projected = realpathSync(resolve(logical, relative(found.directory, physicalFile)))
    if (!same(projected, physicalFile)) {
      throw new Error('N1 selected file differs through generated route')
    }
    const result = { name, ...found, snapshot: item, slot, slotModules, logical, selected }
    proven.set(found.directory, result)
    if (provenance.length >= 512) {
      throw new Error('N1 bounded dependency route receipt overflow')
    }
    provenance.push({
      specifier,
      resolver: context.label,
      anchor: context.anchor,
      lookupSemantics: context.lookupSemantics || 'original resolver.resolve.paths',
      logicalEntry: logical,
      lookupCandidatesBeforeSelected: candidates.slice(0, candidates.indexOf(logical)),
      links: chain,
      canonicalPackage: found.directory,
      selectedFile: selected,
      canonicalSelectedFile: physicalFile,
      selectedSha256: sha(readFileSync(physicalFile)),
      name,
      version: found.json.version,
      packageJsonSha256: found.packageJsonSha256,
      snapshotKey: identity.key,
      frozenSnapshotSha256: sha(item.text),
      edgeKind: identity.kind,
      edgeEvidence: identity.evidence
    })
    return result
  }
  const own = { resolver: require, label: 'hosted-config-require', anchor: configFilename }
  function fromOwn(specifier) {
    return prove(own, specifier, require.resolve(specifier))
  }
  // Prove the original origins before constructing their unchanged createRequire resolvers.
  const pmOrigin = fromOwn('@tiptap/pm/view'),
    reactOrigin = fromOwn('@tiptap/react'),
    starterOrigin = fromOwn('@tiptap/starter-kit')
  const pmRequire = createRequire(pmOrigin.selected)
  const reactRequire = createRequire(reactOrigin.selected)
  const starterRequire = createRequire(starterOrigin.selected)
  const contexts = [
    own,
    {
      resolver: reactRequire,
      origin: reactOrigin,
      label: 'original-react-require',
      anchor: reactOrigin.selected
    },
    {
      resolver: starterRequire,
      origin: starterOrigin,
      label: 'original-starter-require',
      anchor: starterOrigin.selected
    },
    {
      resolver: pmRequire,
      origin: pmOrigin,
      label: 'original-pm-require',
      anchor: pmOrigin.selected
    }
  ]
  function resolveFrom(context, name) {
    const packageName = name.startsWith('@')
      ? name.split('/').slice(0, 2).join('/')
      : name.split('/')[0]
    for (const lookup of context.resolver.resolve.paths(name) || []) {
      const candidate = resolve(lookup, packageName)
      if (!exists(candidate)) {
        continue
      }
      // Refuse an unproved first entry even when its missing/unexported specifier permits an alternative.
      entryIdentity(context, packageName, candidate)
      break
    }
    let selected
    try {
      selected = context.resolver.resolve(name)
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw error
      }
      return null
    }
    // Provenance/name/version/source failures are outside the missing-specifier catch.
    return prove(context, name, selected)
  }
  function locate(name) {
    for (const context of contexts) {
      const result = resolveFrom(context, name)
      if (result) {
        return result
      }
    }
    throw new Error(`Missing exact own-install package source: ${name}`)
  }
  function pmLocate(name) {
    const selected = pmRequire.resolve(name)
    return prove(contexts[3], name, selected)
  }
  function esmFile(packageInfo) {
    const filename = packageInfo.json.module
    if (!filename || isAbsolute(filename)) {
      throw new Error(`No relative declared ESM source: ${packageInfo.name}`)
    }
    return containedFile(packageInfo.directory, resolve(packageInfo.directory, filename))
  }
  return {
    lockDocument,
    nodeModules,
    metadataFile,
    metadataBytes,
    metadata,
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
  }
}
