import type { RpcMethod } from '../core'
import { MOBILE_WEB_REVIEW_COMMENT_METHOD } from './mobile-web-review-comment-mutations'
import { MOBILE_WEB_REVIEW_CREATION_METHODS } from './mobile-web-review-creation'
import { MOBILE_WEB_REVIEW_DIFF_METHOD } from './mobile-web-review-diff'
import { MOBILE_WEB_REVIEW_MANAGE_METHOD } from './mobile-web-review-management'
import { MOBILE_WEB_REVIEW_QUERY_METHOD } from './mobile-web-review-query'
import { MOBILE_WEB_REVIEW_READ_METHOD } from './mobile-web-review-read'
import { MOBILE_WEB_REVIEW_SUBMIT_METHOD } from './mobile-web-review-submission'

// The page's whole provider-review surface: GitHub and GitLab differ only inside these handlers.
export const MOBILE_WEB_REVIEW_METHODS: RpcMethod[] = [
  MOBILE_WEB_REVIEW_READ_METHOD,
  MOBILE_WEB_REVIEW_DIFF_METHOD,
  MOBILE_WEB_REVIEW_QUERY_METHOD,
  MOBILE_WEB_REVIEW_COMMENT_METHOD,
  MOBILE_WEB_REVIEW_MANAGE_METHOD,
  MOBILE_WEB_REVIEW_SUBMIT_METHOD,
  ...MOBILE_WEB_REVIEW_CREATION_METHODS
]
