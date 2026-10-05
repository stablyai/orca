import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { MobileSessionTab } from './mobile-session-route-types'

type MarkdownTab = Extract<MobileSessionTab, { type: 'markdown' }>
type FileTab = Extract<MobileSessionTab, { type: 'file' }>
type BrowserTab = Extract<MobileSessionTab, { type: 'browser' }>
type AgentSessionTab = Extract<MobileSessionTab, { type: 'agent-session' }>
type SetActionTarget<T> = Dispatch<SetStateAction<T | null>>

/** A terminal row's long-press target, addressed by tab id: a row may have no handle yet. */
export type TerminalActionTarget = {
  tabId: string
  handle: string | null
  title: string
  isActive: boolean
}

export function useMobileSessionTabActionTargets() {
  const [actionTarget, setActionTarget] = useState<TerminalActionTarget | null>(null)
  const [markdownActionTarget, setMarkdownActionTarget] = useState<MarkdownTab | null>(null)
  const [fileActionTarget, setFileActionTarget] = useState<FileTab | null>(null)
  const [browserActionTarget, setBrowserActionTarget] = useState<BrowserTab | null>(null)
  const [agentSessionActionTarget, setAgentSessionActionTarget] = useState<AgentSessionTab | null>(
    null
  )

  return {
    actionTarget,
    agentSessionActionTarget,
    browserActionTarget,
    fileActionTarget,
    markdownActionTarget,
    setActionTarget,
    setAgentSessionActionTarget,
    setBrowserActionTarget,
    setFileActionTarget,
    setMarkdownActionTarget
  }
}

export function useMobileSessionTabActionSheetOpener(args: {
  activeSessionTabIdRef: MutableRefObject<string | null>
  setActionTarget: SetActionTarget<TerminalActionTarget>
  setMarkdownActionTarget: SetActionTarget<MarkdownTab>
  setFileActionTarget: SetActionTarget<FileTab>
  setBrowserActionTarget: SetActionTarget<BrowserTab>
  setAgentSessionActionTarget: SetActionTarget<AgentSessionTab>
}): (tab: MobileSessionTab) => void {
  const {
    activeSessionTabIdRef,
    setActionTarget,
    setAgentSessionActionTarget,
    setBrowserActionTarget,
    setFileActionTarget,
    setMarkdownActionTarget
  } = args
  return useCallback(
    (tab: MobileSessionTab) => {
      if (tab.type === 'terminal') {
        setActionTarget({
          tabId: tab.id,
          handle: typeof tab.terminal === 'string' ? tab.terminal : null,
          title: tab.title,
          isActive: tab.id === activeSessionTabIdRef.current
        })
      } else if (tab.type === 'markdown') {
        setMarkdownActionTarget(tab)
      } else if (tab.type === 'file') {
        setFileActionTarget(tab)
      } else if (tab.type === 'agent-session') {
        setAgentSessionActionTarget(tab)
      } else {
        setBrowserActionTarget(tab)
      }
    },
    [
      activeSessionTabIdRef,
      setActionTarget,
      setAgentSessionActionTarget,
      setBrowserActionTarget,
      setFileActionTarget,
      setMarkdownActionTarget
    ]
  )
}
