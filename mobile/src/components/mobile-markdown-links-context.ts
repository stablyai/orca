import { createContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createNativeChatFileLinkHooks } from '../../../src/shared/native-chat/native-chat-file-link-hooks'
import type { NativeChatFileLinkExistence } from '../../../src/shared/native-chat/native-chat-file-link-existence'
import type { GitHubRepoReference } from '../../../src/shared/github/github-reference-links'

/** What a chat knows about its workspace for links in its text; absent outside chat. */
export type MobileMarkdownLinks = {
  /** Null until the workspace's folder is known; paths then link without a check. */
  fileLinks: NativeChatFileLinkExistence | null
  /** Where bare `#123` points; null leaves it text. */
  githubRepo: GitHubRepoReference | null
}

export const MobileMarkdownLinksContext = createContext<MobileMarkdownLinks | null>(null)

export const { useNativeChatFileLinkExistsFrom, useRecheckNativeChatFileLinksAfterTurn } =
  createNativeChatFileLinkHooks({ useEffect, useMemo, useRef, useSyncExternalStore })
