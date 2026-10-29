import { createContext } from 'react'

// Screens that offer choices for a tapped web link provide this; absent, the system browser opens it.
export const MarkdownLinkHandlerContext = createContext<((url: string) => void) | null>(null)
