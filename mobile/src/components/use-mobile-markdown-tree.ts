import type { Root } from 'mdast'
import { useMemo } from 'react'
import {
  linkGitHubReferences,
  type GitHubRepoReference
} from '../../../src/shared/github/github-reference-links'
import {
  linkNativeChatFilePaths,
  type FileLinkExists
} from '../../../src/shared/native-chat/native-chat-file-link-tree'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'
import { protectMobileMarkdownVisualLines } from './mobile-markdown-visual-lines'

const NO_DIRECTIVES: NativeChatVisualDirective[] = []

/** Chat links drawn into the tree: host-confirmed file paths and `#123` refs. */
export type MobileMarkdownTreeLinks = {
  fileLinkExists?: FileLinkExists
  githubRepo?: GitHubRepoReference | null
}

/** The tree MobileMarkdown draws; with `visuals`, directive lines become placeholders. */
export function useMobileMarkdownTree(
  text: string,
  visuals: boolean,
  growing: boolean,
  { fileLinkExists, githubRepo }: MobileMarkdownTreeLinks = {}
): { root: Root; directives: NativeChatVisualDirective[] } {
  const visualLines = useMemo(
    () => (visuals ? protectMobileMarkdownVisualLines(text) : null),
    [text, visuals]
  )
  const source = visualLines?.text ?? text
  const root = useMemo(() => {
    const parsed = parseMobileMarkdownTree(source, growing)
    // Same order as desktop: file links first, so a path's `#` never becomes an issue link.
    if (fileLinkExists) {
      linkNativeChatFilePaths(parsed, fileLinkExists)
    }
    if (githubRepo) {
      linkGitHubReferences(parsed, githubRepo)
    }
    return parsed
  }, [source, growing, fileLinkExists, githubRepo])
  return { root, directives: visualLines?.directives ?? NO_DIRECTIVES }
}
