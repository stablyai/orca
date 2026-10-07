export const FINGERPRINT_FORMAT = 1
export const PLATFORMS = ['android', 'ios']
export const VARIANTS = ['native', 'ota']
const LISTED_LINE_LIMIT = 40
const NAMED_INPUT_LIMIT = 5

function diffKeyedDigests(base, head) {
  const added = Object.keys(head).filter((key) => !(key in base))
  const removed = Object.keys(base).filter((key) => !(key in head))
  const changed = Object.keys(head).filter((key) => key in base && base[key] !== head[key])
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

function sourcesById(sources) {
  return Object.fromEntries(sources.map((source) => [source.id, source.hash]))
}

const NATIVE_INPUT_NAMES = {
  expoConfig: 'app config',
  'package:react-native': 'react-native version',
  patches: 'patches/'
}

/** Plain-words name for an @expo/fingerprint source id. */
export function nativeInputName(id) {
  if (NATIVE_INPUT_NAMES[id]) {
    return NATIVE_INPUT_NAMES[id]
  }
  if (id.startsWith('expoAutolinkingConfig:')) {
    return 'Expo autolinking config'
  }
  if (id.startsWith('rncoreAutolinkingConfig:')) {
    return 'React Native autolinking config'
  }
  const dependency = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/(?:android|ios)$/.exec(id)
  if (dependency) {
    return `native module ${dependency[1]}`
  }
  const local = /^modules\/([^/]+)\/(?:android|ios)$/.exec(id)
  if (local) {
    return `native module ${local[1]} (local)`
  }
  // A plugin's path already says what it is.
  return id.startsWith('plugins/') ? id : `file ${id}`
}

function unknownVerdict(reason) {
  return { changed: null, reason, parts: [], files: null }
}

function isShellRecord(record) {
  const isObject = (value) => typeof value === 'object' && value !== null
  const hashed = (entry, isValid) => typeof entry?.hash === 'string' && isValid(entry)
  return PLATFORMS.every(
    (platform) =>
      hashed(record.native?.[platform], (entry) => Array.isArray(entry.sources)) &&
      VARIANTS.every((variant) =>
        hashed(record.shellJs?.[variant]?.[platform], (entry) => isObject(entry.modules))
      )
  )
}

/** Pure verdict over two `compute` records; `changed` is null when they cannot be compared. */
export function compareShellFingerprints(base, head) {
  if (!base || !head) {
    return unknownVerdict('a fingerprint record is missing or unreadable')
  }
  if (base.format !== FINGERPRINT_FORMAT || head.format !== FINGERPRINT_FORMAT) {
    return unknownVerdict('fingerprint format differs')
  }
  if (!isShellRecord(base) || !isShellRecord(head)) {
    return unknownVerdict('a fingerprint record is malformed')
  }
  const parts = []
  for (const platform of PLATFORMS) {
    if (base.native[platform].hash !== head.native[platform].hash) {
      const diff = diffKeyedDigests(
        sourcesById(base.native[platform].sources),
        sourcesById(head.native[platform].sources)
      )
      const inputs = [...diff.changed, ...diff.added, ...diff.removed].map(nativeInputName)
      parts.push({ kind: 'native', platform, inputs: [...new Set(inputs)] })
    }
  }
  const files = { added: new Set(), removed: new Set(), changed: new Set() }
  for (const variant of VARIANTS) {
    for (const platform of PLATFORMS) {
      const before = base.shellJs[variant][platform]
      const after = head.shellJs[variant][platform]
      if (before.hash === after.hash) {
        continue
      }
      const diff = diffKeyedDigests(before.modules, after.modules)
      const modules = diff.added.length + diff.removed.length + diff.changed.length
      parts.push({ kind: 'shellJs', variant, platform, modules })
      for (const kind of ['added', 'removed', 'changed']) {
        diff[kind].forEach((file) => files[kind].add(file))
      }
    }
  }
  const sorted = (set) => [...set].sort()
  return {
    changed: parts.length > 0,
    reason: null,
    parts,
    files: {
      added: sorted(files.added),
      removed: sorted(files.removed),
      changed: sorted(files.changed)
    }
  }
}

/** Names the part that moved and why, e.g. `native (android): app config`. */
export function describePart(part) {
  if (part.kind === 'native') {
    const shown = part.inputs.slice(0, NAMED_INPUT_LIMIT)
    const more = part.inputs.length - shown.length
    return `native (${part.platform}): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`
  }
  const what =
    part.modules === 0
      ? 'bundle only, no source module differs (an inlined constant, a transform or a bundler change)'
      : `${part.modules} ${part.modules === 1 ? 'module differs' : 'modules differ'}`
  return `shell JS (${part.variant}, ${part.platform}): ${what}`
}

const PACKAGE_FILE = /^(mobile\/node_modules\/(?:@[^/]+\/)?[^/]+)\//

/** Collapses dependency files to one line per package so a bump does not flood the list. */
export function explainingFiles(files) {
  const lines = []
  for (const kind of ['changed', 'added', 'removed']) {
    const packages = new Map()
    for (const file of files[kind]) {
      const pkg = PACKAGE_FILE.exec(file)?.[1]
      if (pkg) {
        packages.set(pkg, (packages.get(pkg) ?? 0) + 1)
      } else {
        lines.push(`${kind}: ${file}`)
      }
    }
    for (const [pkg, count] of packages) {
      lines.push(`${kind}: ${pkg}/ (${count} file${count === 1 ? '' : 's'})`)
    }
  }
  return lines
}

function cappedList(lines) {
  const shown = lines.slice(0, LISTED_LINE_LIMIT).map((line) => `- \`${line}\``)
  if (lines.length > LISTED_LINE_LIMIT) {
    shown.push(`- +${lines.length - LISTED_LINE_LIMIT} more`)
  }
  return shown
}

function headline(verdict, since) {
  if (since) {
    return `Mobile release needed since ${since}: ${verdict.changed ? 'yes' : 'no'}`
  }
  return verdict.changed ? 'Mobile shell: changed' : 'Mobile shell: unchanged — OTA delivers this'
}

/** `since` names the release tag the base record was computed at; empty for a pull request. */
export function renderShellVerdictMarkdown(verdict, since = '') {
  if (verdict.changed === null) {
    return `### Mobile shell: verdict unknown — ${verdict.reason}\n`
  }
  const lines = [`### ${headline(verdict, since)}`]
  if (verdict.changed) {
    lines.push('', ...verdict.parts.map((part) => `- ${describePart(part)}`))
    const files = explainingFiles(verdict.files)
    if (files.length > 0) {
      lines.push('', 'Sources that differ inside the changed bundles:', ...cappedList(files))
    }
  }
  if (since) {
    lines.push(
      '',
      'No iOS release anchor: iOS parts are compared with this Android release commit.'
    )
  }
  return `${lines.join('\n')}\n`
}
