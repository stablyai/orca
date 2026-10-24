import { useEffect, useSyncExternalStore } from 'react'
import {
  flushTerminalViewParking,
  getTerminalParkingRevision,
  startTerminalViewParkingOwner,
  subscribeTerminalParkingFlush
} from '../components/terminal-pane/terminal-view-parking-owner'
import { startTabAgentExitOwner } from '../lib/tab-agent-exit-owner'

export function TerminalRuntimeOwners(): null {
  const revision = useSyncExternalStore(
    subscribeTerminalParkingFlush,
    getTerminalParkingRevision,
    getTerminalParkingRevision
  )
  useEffect(() => startTerminalViewParkingOwner(), [])
  useEffect(() => startTabAgentExitOwner(), [])
  // Committed view inputs arrive in this commit's effects; the nested flush runs before IPC.
  useEffect(() => {
    flushTerminalViewParking()
  }, [revision])
  return null
}
