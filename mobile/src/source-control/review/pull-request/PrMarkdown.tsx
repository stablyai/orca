import { useMemo } from 'react'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { MobileMarkdownLinksContext } from '../../../components/mobile-markdown-links-context'
import { MOBILE_MARKDOWN_DOCUMENT_SCALE } from '../../../components/mobile-markdown-styles'

const GITHUB_PAGE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//i

/** A PR body or comment: GitHub text whose bare `#123` links into the PR's own repository, as on
 *  desktop. `url` is the PR's or comment's github.com page. */
export function PrMarkdown({
  content,
  url,
  document = false
}: {
  content: string
  url: string | undefined
  /** The PR body: 14pt document text; comments stay at 13pt. */
  document?: boolean
}) {
  const match = url ? GITHUB_PAGE.exec(url) : null
  const owner = match?.[1]
  const repo = match?.[2]
  const links = useMemo(
    () => ({ fileLinks: null, githubRepo: owner && repo ? { owner, repo } : null }),
    [owner, repo]
  )
  return (
    <MobileMarkdownLinksContext.Provider value={links}>
      <MobileMarkdown
        content={content}
        textScale={document ? MOBILE_MARKDOWN_DOCUMENT_SCALE : undefined}
      />
    </MobileMarkdownLinksContext.Provider>
  )
}
