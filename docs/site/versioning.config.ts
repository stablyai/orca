// Keep current docs in content/docs for stable URLs; reserve content/versions/<id> for a future loader. Versioned routes are not enabled.
export type DocsVersion = {
  readonly id: string
  readonly label: string
  readonly sourceDir: string
  readonly urlPrefix: string
}

export const docsVersioning = {
  current: {
    id: 'latest',
    label: 'Latest',
    sourceDir: 'content/docs',
    urlPrefix: '/docs'
  },
  versionsDir: 'content/versions',
  versions: [] as readonly DocsVersion[]
} as const

export type DocsVersionId = (typeof docsVersioning.versions)[number]['id']

export function docsVersionPath(version: string = docsVersioning.current.id): string {
  return version === docsVersioning.current.id
    ? docsVersioning.current.urlPrefix
    : `${docsVersioning.current.urlPrefix}/${version}`
}
