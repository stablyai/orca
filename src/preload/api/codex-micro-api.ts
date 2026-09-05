import type { CodexMicroConnectionState, CodexMicroInputEvent } from '../../shared/codex-micro-types'

export type CodexMicroApi = {
  getState: () => Promise<CodexMicroConnectionState>
  subscribeState: (callback: (state: CodexMicroConnectionState) => void) => () => void
  subscribeInput: (callback: (event: CodexMicroInputEvent) => void) => () => void
  setOutputSnapshot: (args: {
    rgbcfg: Record<string, unknown>
    thstatus: unknown[]
  }) => Promise<void>
  retry: () => Promise<void>
  release: () => Promise<void>
}
