import { createContext, useContext } from 'react'

type OpenFile = (pathText: string) => void

/** The chat's one file opener, provided by its view; undefined where the chat cannot open files. */
export const MobileNativeChatOpenFileContext = createContext<OpenFile | undefined>(undefined)

/** Every chat surface that opens a file reads the opener here, so no card or row needs it passed down. */
export function useMobileNativeChatOpenFile(): OpenFile | undefined {
  return useContext(MobileNativeChatOpenFileContext)
}
