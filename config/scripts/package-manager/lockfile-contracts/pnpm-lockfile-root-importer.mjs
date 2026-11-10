import { parseAllDocuments } from 'yaml'

/** Strips pnpm's peer suffix: `43.7.5(supports-color@7.2.0)` -> `43.7.5`. */
export function lockedVersion(entry) {
  const version = typeof entry === 'string' ? entry : entry?.version
  return typeof version === 'string' ? version.replace(/\(.*$/, '') : null
}

/** pnpm 12 splits the lockfile into a package-manager document and the project one; merge both. */
export function lockfileRootImporter(contents) {
  const importer = {}
  for (const document of parseAllDocuments(contents)) {
    if (document.errors.length) {
      throw document.errors[0]
    }
    Object.assign(importer, document.toJS()?.importers?.['.'])
  }
  return importer
}
