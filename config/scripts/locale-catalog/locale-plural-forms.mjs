import fs from 'node:fs/promises'
import path from 'node:path'

const PLURAL_KEY_RE = /^(.*)_(zero|one|two|few|many|other)$/

// Locales with more CLDR plural categories than English (ru few/many) source those forms from `_other`.
export function resolveLocaleSourceKey(enEntries, localeName, key) {
  if (enEntries.has(key)) {
    return key
  }
  const plural = PLURAL_KEY_RE.exec(key)
  if (!plural || !localeName || !enEntries.has(`${plural[1]}_other`)) {
    return undefined
  }
  return pluralCategories(localeName).includes(plural[2]) ? `${plural[1]}_other` : undefined
}

// translate('x', other, { count, defaultValue_one }) names the English catalog keys x_one and x_other.
export function pluralFamilyDefaults(ts, key, fallback, options) {
  if (PLURAL_KEY_RE.test(key) || !options || !ts.isObjectLiteralExpression(options)) {
    return undefined
  }
  const property = (name) => options.properties.find((entry) => entry.name?.getText() === name)
  const one = property('defaultValue_one')
  // Without defaultValue_one, count only fills {{count}} in a singular key; without count, i18next reads the base key.
  if (!one || !property('count')) {
    return undefined
  }
  const oneDefault =
    ts.isPropertyAssignment(one) && ts.isStringLiteralLike(one.initializer)
      ? one.initializer.text
      : undefined
  return [
    [`${key}_one`, oneDefault],
    [`${key}_other`, fallback]
  ]
}

const COUNT_PLACEHOLDER_RE = /^\{\{\s*count\s*[,}]/

// i18next always passes count to plural forms, so a locale may add it where English omits it (ru 21 uses _one).
export function interpolationVariablesMatch(sourceKey, enVariables, localeVariables) {
  if (enVariables.join('|') === localeVariables.join('|')) {
    return true
  }
  const withoutCount = (variable) => !COUNT_PLACEHOLDER_RE.test(variable)
  return (
    PLURAL_KEY_RE.test(sourceKey) &&
    !enVariables.some((variable) => COUNT_PLACEHOLDER_RE.test(variable)) &&
    enVariables.join('|') === localeVariables.filter(withoutCount).join('|')
  )
}

function pluralCategories(localeName) {
  try {
    return new Intl.PluralRules(localeName).resolvedOptions().pluralCategories
  } catch {
    return []
  }
}

// Untranslated CLDR forms (fr/es/pt many, tr one) reuse the locale's `_other` instead of English; inserted beside it.
function withMissingPluralForms(catalog, categories, prefix = '', added = []) {
  const filled = {}
  for (const [key, value] of Object.entries(catalog)) {
    const keyPath = prefix ? `${prefix}.${key}` : key
    filled[key] =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? withMissingPluralForms(value, categories, keyPath, added).catalog
        : value
    if (typeof value !== 'string' || !key.endsWith('_other')) {
      continue
    }
    const base = key.slice(0, -'other'.length)
    for (const category of categories) {
      if (!Object.hasOwn(catalog, `${base}${category}`)) {
        filled[`${base}${category}`] = value
        added.push(`${prefix ? `${prefix}.` : ''}${base}${category}`)
      }
    }
  }
  return { catalog: filled, added }
}

/** Verifies (or with fix, writes) the plural forms a desktop locale catalog needs; runtimes load catalogs as-is. */
export async function syncLocalePluralForms(catalogPath, catalog, fix) {
  const fileName = path.basename(catalogPath)
  const plural = withMissingPluralForms(catalog, pluralCategories(fileName.replace(/\.json$/, '')))
  if (plural.added.length === 0) {
    return { ok: true, catalog }
  }
  if (!fix) {
    console.error(`${fileName} is missing CLDR plural forms that runtimes no longer fill:`)
    console.error(
      plural.added
        .slice(0, 20)
        .map((key) => `missing plural form: ${key}`)
        .join('\n')
    )
    return { ok: false }
  }
  await fs.writeFile(catalogPath, `${JSON.stringify(plural.catalog, null, 2)}\n`, 'utf8')
  console.log(`Added ${plural.added.length} plural form(s) to ${fileName} from \`_other\`.`)
  return { ok: true, catalog: plural.catalog }
}
