import type { PageHeaderRequest } from './page-header-payload'

// Native screens draw their own stack header; only a shell page, whose bar the shell can draw, claims it.
export function usePageHeaderClaim(_request: PageHeaderRequest | null): boolean {
  return false
}
