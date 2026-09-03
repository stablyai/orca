import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { MobileSessionTab, Terminal } from './mobile-session-route-types'

type MarkdownTab = Extract<MobileSessionTab, { type: 'markdown' }>
type FileTab = Extract<MobileSessionTab, { type: 'file' }>
type BrowserTab = Extract<MobileSessionTab, { type: 'browser' }>
type AgentSessionTab = Extract<MobileSessionTab, { type: 'agent-session' }>
type SetActionTarget<T> = Dispatch<SetStateAction<T | null>>

export function useMobileSessionTabActionTargets() {
  const [actionTarget, setActionTarget] = useState<Terminal | null>(null)
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
  activeHandleRef: MutableRefObject<string | null>
  setActionTarget: SetActionTarget<Terminal>
  setMarkdownActionTarget: SetActionTarget<MarkdownTab>
  setFileActionTarget: SetActionTarget<FileTab>
  setBrowserActionTarget: SetActionTarget<BrowserTab>
  setAgentSessionActionTarget: SetActionTarget<AgentSessionTab>
}): (tab: MobileSessionTab) => void {
  const {
    activeHandleRef,
    setActionTarget,
    setAgentSessionActionTarget,
    setBrowserActionTarget,
    setFileActionTarget,
    setMarkdownActionTarget
  } = args
  return useCallback(
    (tab: MobileSessionTab) => {
      if (tab.type === 'terminal') {
        if (typeof tab.terminal !== 'string') {
          return
        }
        setActionTarget({
          handle: tab.terminal,
          title: tab.title,
          isActive: tab.terminal === activeHandleRef.current
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
      activeHandleRef,
      setActionTarget,
      setAgentSessionActionTarget,
      setBrowserActionTarget,
      setFileActionTarget,
      setMarkdownActionTarget
    ]
  )
}
