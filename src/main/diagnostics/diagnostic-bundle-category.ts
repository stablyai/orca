import {
  DIAGNOSTIC_BUNDLE_CATEGORIES,
  type DiagnosticBundleCategory
} from '../../shared/diagnostic-bundle-export-types'

const CATEGORY_SET = new Set<string>(DIAGNOSTIC_BUNDLE_CATEGORIES)

export function isDiagnosticBundleCategory(value: string): value is DiagnosticBundleCategory {
  return CATEGORY_SET.has(value)
}

export function parseDiagnosticBundleCategories(
  values: readonly string[]
): DiagnosticBundleCategory[] {
  return values.map((value) => {
    if (!isDiagnosticBundleCategory(value)) {
      throw new Error(
        `Unknown diagnostic bundle category "${value}". Known categories: ${DIAGNOSTIC_BUNDLE_CATEGORIES.join(
          ', '
        )}`
      )
    }
    return value
  })
}

export function resolveDiagnosticBundleCategories(args: {
  include?: readonly DiagnosticBundleCategory[]
  exclude?: readonly DiagnosticBundleCategory[]
}): DiagnosticBundleCategory[] {
  const selected = new Set(args.include?.length ? args.include : DIAGNOSTIC_BUNDLE_CATEGORIES)
  for (const category of args.exclude ?? []) {
    selected.delete(category)
  }
  return DIAGNOSTIC_BUNDLE_CATEGORIES.filter((category) => selected.has(category))
}
