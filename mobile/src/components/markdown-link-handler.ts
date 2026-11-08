import { createContext } from 'react'
import { openExternalLink } from '../platform/external-link'

// Screens that offer choices for a tapped web link provide this; elsewhere the system browser opens it.
export const MarkdownLinkHandlerContext = createContext<(url: string) => void>(openExternalLink)

export const MarkdownInferredFileLinkHandlerContext = createContext<
  ((pathText: string) => void) | undefined
>(undefined)
