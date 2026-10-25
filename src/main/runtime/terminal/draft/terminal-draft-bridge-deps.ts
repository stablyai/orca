import {
  readPiDraftBridgeCapability,
  requestPiDraftCapture,
  requestPiDraftReplace,
  type PiDraftBridgeCapability
} from '../../../pi/draft-bridge-client'
import {
  readPiDraftBridgeSession,
  type PiDraftBridgePaths
} from '../../../pi/draft-bridge-directory'
import type { PiDraftBridgeResponse } from '../../../pi/draft-bridge-protocol'
import type { WriteSettlement } from '../../../../shared/pty-write-settlement'

export type TerminalDraftBridgeDeps = {
  readSession: (ptyId: string) => PiDraftBridgePaths | null
  readCapability: (paths: PiDraftBridgePaths) => Promise<PiDraftBridgeCapability>
  capture: (paths: PiDraftBridgePaths) => Promise<PiDraftBridgeResponse | null>
  replace: (
    paths: PiDraftBridgePaths,
    text: string,
    baseToken: string
  ) => Promise<PiDraftBridgeResponse | null>
  now: () => number
}

export function createPiTerminalDraftDeps(userDataPath: string): TerminalDraftBridgeDeps {
  return {
    readSession: (ptyId) => readPiDraftBridgeSession(userDataPath, ptyId),
    readCapability: (paths) => readPiDraftBridgeCapability(paths),
    capture: (paths) => requestPiDraftCapture(paths),
    replace: (paths, text, baseToken) => requestPiDraftReplace(paths, text, baseToken),
    now: () => Date.now()
  }
}

export type TerminalDraftSubmitInput = () => Promise<{
  accepted: boolean
  writeSettlement?: WriteSettlement
}>
