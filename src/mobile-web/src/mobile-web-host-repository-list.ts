import {
  MOBILE_WEB_REPOSITORY_LIMIT,
  MobileWebHostRepositoryListSchema,
  MobileWebHostRepositorySchema,
  type MobileWebHostRepository
} from '../../shared/mobile-web/workspace-presentation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

export type MobileWebHostRepositoryCatalog = {
  repositories: MobileWebHostRepository[]
  truncated: boolean
}

/** Parses a raw `repo.list` answer. A row the page cannot read is dropped, and the catalog is
 * bounded, so one malformed repo never blanks the workspace list. */
export function mobileWebHostRepositoryCatalog(result: unknown): MobileWebHostRepositoryCatalog {
  const parsed = MobileWebHostRepositoryListSchema.safeParse(result)
  if (!parsed.success) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  const rows = parsed.data.repos.flatMap((repo) => {
    const row = MobileWebHostRepositorySchema.safeParse(repo)
    return row.success ? [row.data] : []
  })
  return {
    repositories: rows.slice(0, MOBILE_WEB_REPOSITORY_LIMIT),
    truncated: rows.length > MOBILE_WEB_REPOSITORY_LIMIT
  }
}
