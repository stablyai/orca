import {
  collectInterpolationVariables,
  collectStringLeaves,
  shouldPreserveEnglishValue
} from './locale-translation-policy.mjs'
import {
  translatablePluginChrome,
  translatablePluginChromeContainer
} from '../../src/shared/plugins/plugin-translatable-chrome.ts'

export const PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES = 20_000
export const PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH = 16
export const PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH = 8192
export const PLUGIN_LANGUAGE_CATALOG_MAX_KEY_LENGTH = 128
export const PLUGIN_LANGUAGE_PACK_MAX_BYTES = 5 * 1024 * 1024

const DANGEROUS_CATALOG_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PROTECTED_TRANSLATION_ROOT = 'auto.components.settings.'

// Why: the host keeps its protected root and module pattern private; both literals are copied.
export function protectedFromLanguagePacks(path) {
  return (
    path.startsWith(PROTECTED_TRANSLATION_ROOT) &&
    !translatablePluginChrome(path) &&
    /^plugin/i.test(path.slice(PROTECTED_TRANSLATION_ROOT.length))
  )
}

export function protectedContainerFromLanguagePacks(path) {
  return (
    path.startsWith(PROTECTED_TRANSLATION_ROOT) &&
    !translatablePluginChromeContainer(path) &&
    /^plugin/i.test(path.slice(PROTECTED_TRANSLATION_ROOT.length))
  )
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function serializeCatalog(catalog) {
  function sortObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return value
    }
    const sorted = Object.create(null)
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      sorted[key] = sortObject(value[key])
    }
    return sorted
  }

  return `${JSON.stringify(sortObject(catalog), null, 2)}\n`
}

export function deleteNestedLeaf(catalog, dottedKey) {
  const parts = dottedKey.split('.')
  if (parts.some((part) => DANGEROUS_CATALOG_KEYS.has(part))) {
    throw new Error(`unsafe catalog path: ${dottedKey}`)
  }
  const parents = []
  let cursor = catalog
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null || Array.isArray(cursor[part])) {
      return false
    }
    parents.push([cursor, part])
    cursor = cursor[part]
  }
  if (!Object.hasOwn(cursor, parts.at(-1))) {
    return false
  }
  delete cursor[parts.at(-1)]
  for (const [parent, part] of parents.toReversed()) {
    if (Object.keys(parent[part]).length > 0) {
      break
    }
    delete parent[part]
  }
  return true
}

function hasControlCharacter(key) {
  for (let index = 0; index < key.length; index += 1) {
    if (key.charCodeAt(index) <= 31) {
      return true
    }
  }
  return false
}

export function inspectCatalogShape(catalog, byteLength = 0) {
  const findings = []
  const protectedContainers = []
  if (byteLength > PLUGIN_LANGUAGE_PACK_MAX_BYTES) {
    findings.push(`file exceeds ${PLUGIN_LANGUAGE_PACK_MAX_BYTES} bytes`)
  }
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) {
    findings.push('catalog root must be an object')
    return { findings, protectedContainers, nodeCount: 0 }
  }

  let nodeCount = 0
  const stack = [{ value: catalog, path: '', depth: 0 }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame.depth > PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH) {
      findings.push(`catalog exceeds depth ${PLUGIN_LANGUAGE_CATALOG_MAX_DEPTH} at ${frame.path}`)
    }
    for (const [key, value] of Object.entries(frame.value)) {
      nodeCount += 1
      const currentPath = frame.path ? `${frame.path}.${key}` : key
      if (key.length === 0) {
        findings.push(`empty key segment at ${currentPath || '(root)'}`)
      } else if (
        key.includes('.') ||
        hasControlCharacter(key) ||
        key.length > PLUGIN_LANGUAGE_CATALOG_MAX_KEY_LENGTH ||
        DANGEROUS_CATALOG_KEYS.has(key)
      ) {
        findings.push(`unsafe key segment at ${currentPath}`)
      }
      if (typeof value === 'string') {
        continue
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        findings.push(`non-string leaf at ${currentPath}`)
        continue
      }
      if (protectedContainerFromLanguagePacks(currentPath)) {
        protectedContainers.push(currentPath)
      }
      stack.push({ value, path: currentPath, depth: frame.depth + 1 })
    }
  }
  if (nodeCount > PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES) {
    findings.push(`catalog exceeds ${PLUGIN_LANGUAGE_CATALOG_MAX_ENTRIES} nodes`)
  }
  return { findings, protectedContainers, nodeCount }
}

function samePlaceholders(left, right) {
  return (
    collectInterpolationVariables(left).join('|') === collectInterpolationVariables(right).join('|')
  )
}

export function analyzeCatalog(enCatalog, packCatalog, packBytes = 0) {
  const englishLeaves = new Map(
    collectStringLeaves(enCatalog).map(({ key, value }) => [key, value])
  )
  const packLeaves = new Map(collectStringLeaves(packCatalog).map(({ key, value }) => [key, value]))
  const required = new Map(
    [...englishLeaves].filter(
      ([key, value]) =>
        !protectedFromLanguagePacks(key) &&
        value.length <= PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH &&
        !shouldPreserveEnglishValue(value, key)
    )
  )
  const shape = inspectCatalogShape(packCatalog, packBytes)
  const result = {
    required,
    englishLeaves,
    packLeaves,
    translated: [],
    copiedEnglish: [],
    missing: [],
    retired: [],
    protected: [...shape.protectedContainers],
    oversize: [],
    placeholderMismatch: [],
    preservedEnglishDrift: [],
    limit: shape.findings
  }

  for (const [key, value] of packLeaves) {
    const english = englishLeaves.get(key)
    if (protectedFromLanguagePacks(key)) {
      result.protected.push(key)
    }
    if (value.length > PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH) {
      result.oversize.push(key)
    }
    if (english === undefined) {
      result.retired.push(key)
    } else if (value !== english && shouldPreserveEnglishValue(english, key)) {
      result.preservedEnglishDrift.push(key)
    }
  }
  result.protected = [...new Set(result.protected)]
  for (const [key, english] of required) {
    const translated = packLeaves.get(key)
    if (translated === undefined) {
      result.missing.push(key)
    } else if (translated.length > PLUGIN_LANGUAGE_CATALOG_MAX_VALUE_LENGTH) {
      continue
    } else if (!samePlaceholders(english, translated)) {
      result.placeholderMismatch.push(key)
    } else if (translated === english) {
      result.copiedEnglish.push(key)
    } else {
      result.translated.push(key)
    }
  }
  return result
}

export function placeholdersMatch(english, translated) {
  return samePlaceholders(english, translated)
}
