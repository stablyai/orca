import type { Root } from 'mdast'
import { useMemo, useRef } from 'react'
import {
  linkGitHubReferences,
  type GitHubRepoReference
} from '../../../src/shared/github/markdown/github-reference-links'
import {
  linkNativeChatFilePaths,
  type FileLinkExists
} from '../../../src/shared/native-chat/native-chat-file-link-tree'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat/native-chat-visual-directive'
import {
  parseGrowingMobileMarkdownTree,
  type MobileMarkdownTreeCache
} from './mobile-markdown-growing-tree'
import { protectMobileMarkdownVisualLines } from './mobile-markdown-visual-lines'

const NO_DIRECTIVES: NativeChatVisualDirective[] = []

/** Chat links drawn into the tree: host-confirmed file paths and `#123` refs. */
export type MobileMarkdownTreeLinks = {
  fileLinkExists: FileLinkExists | undefined
  githubRepo: GitHubRepoReference | null | undefined
}

/** The tree MobileMarkdown draws; with `visuals`, directive lines become placeholders. */
export function useMobileMarkdownTree(
  text: string,
  visuals: boolean,
  growing: boolean,
  chatMath: boolean,
  { fileLinkExists, githubRepo }: MobileMarkdownTreeLinks
): { root: Root; directives: NativeChatVisualDirective[] } {
  const visualLines = useMemo(
    () => (visuals ? protectMobileMarkdownVisualLines(text) : null),
    [text, visuals]
  )
  const source = visualLines?.text ?? text
  const link = useMemo(
    () => (tree: Root) => {
      // Same order as desktop: file links first, so a path's `#` never becomes an issue link.
      if (fileLinkExists) {
        linkNativeChatFilePaths(tree, fileLinkExists)
      }
      if (githubRepo) {
        linkGitHubReferences(tree, githubRepo)
      }
    },
    [fileLinkExists, githubRepo]
  )
  // Streaming text grows a little each frame; blocks it finished earlier are not parsed again.
  const cache = useRef<MobileMarkdownTreeCache | null>(null)
  const root = useMemo(() => {
    const parsed = parseGrowingMobileMarkdownTree(cache.current, source, growing, chatMath, link)
    // Safe if this render is discarded: a later parse reuses the cache only for text it prefixes.
    // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
    cache.current = parsed.cache
    return parsed.root
  }, [source, growing, chatMath, link])
  return { root, directives: visualLines?.directives ?? NO_DIRECTIVES }
}
