import { BRIDGE_APP_INACTIVE_FRAME } from '../bridge/page-lifecycle/bridge-app-inactive'
import {
  BRIDGE_APP_RESUMED_FRAME,
  type BridgeAppFrame
} from '../bridge/page-lifecycle/bridge-app-resumed'
import { useAppLeavesForeground } from '../session/use-app-leaves-foreground'
import { useAppResumeRounds } from '../session/app-resume-rounds'

// The page saves when the app leaves, and answers each resume round whether it may reload onto a newer build.
export function usePageAppPresence(hostId: string, send: (frame: BridgeAppFrame) => void): void {
  useAppLeavesForeground(() => send({ type: BRIDGE_APP_INACTIVE_FRAME }))
  // Only a confirm round has a newer build waiting on it.
  useAppResumeRounds(hostId, (round, confirming) =>
    send({ type: BRIDGE_APP_RESUMED_FRAME, round, ...(confirming ? { reloading: true } : {}) })
  )
}
