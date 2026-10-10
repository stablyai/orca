/**
 * The single source of truth for the public docs version layout.
 *
 * Keep the current docs in `content/docs` so existing URLs stay stable. The
 * reserved `content/versions/<id>` layout gives a future versioned loader a
 * predictable source tree; versioned routes are not enabled yet.
 */
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
