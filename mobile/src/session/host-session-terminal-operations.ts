import type { TerminalOscLinkRange } from '../../../src/shared/terminal-osc-link-ranges'

export type HostSessionTerminalData = string | Uint8Array

export type HostSessionTerminalStreamEvent =
  | {
      type: 'subscribed'
      cols?: number
      rows?: number
    }
  | {
      type: 'scrollback'
      cols: number
      rows: number
      serialized: HostSessionTerminalData
      preserveScroll?: boolean
      throughSequence?: number
      displayMode?: 'auto' | 'desktop' | 'phone'
      oscLinks?: TerminalOscLinkRange[]
      seq?: number
    }
  | {
      type: 'data'
      chunk: HostSessionTerminalData
      throughSequence?: number
      seq?: number
    }
  | {
      type: 'resized'
      cols: number
      rows: number
      serialized?: HostSessionTerminalData
      throughSequence?: number
      displayMode?: 'auto' | 'desktop' | 'phone'
      oscLinks?: TerminalOscLinkRange[]
      seq?: number
    }
  | {
      type: 'metadata'
      displayMode?: 'auto' | 'desktop' | 'phone'
      cwd?: string
    }
  | { type: 'end' | 'error' }

export type HostSessionTerminalSubscribeArgs = {
  workspaceId: string
  terminalId: string
  clientId: string | null
  viewport: { cols: number; rows: number } | null | undefined
  visible: boolean
  capabilities: { terminalBinaryStream: 1; mobileInputLeaseOnly?: 1 }
}

export type HostSessionTerminalOperations = {
  subscribe(
    args: HostSessionTerminalSubscribeArgs,
    onEvent: (event: HostSessionTerminalStreamEvent) => void,
    onError: () => void
  ): () => void
  acknowledge(terminalId: string, throughSequence: number): void
  sendInput(
    terminalId: string,
    text: string,
    enter: boolean,
    clientId: string | null
  ): Promise<boolean>
  sendQueryReply(
    terminalId: string,
    bytes: string,
    clientId: string | null,
    hostSupportsQueryReply: boolean
  ): Promise<boolean>
  setDisplayMode(
    terminalId: string,
    mode: 'auto' | 'desktop',
    viewport: { cols: number; rows: number } | null,
    clientId: string | null
  ): Promise<boolean>
  clear(terminalId: string): Promise<boolean>
  rename(terminalId: string, title: string): Promise<boolean>
  pasteClipboard?(
    terminalId: string,
    bracketedPaste: boolean
  ): Promise<MobileWebTerminalDeviceInputResult | null>
  attachImage?(
    terminalId: string,
    source: 'library' | 'files'
  ): Promise<MobileWebTerminalDeviceInputResult | null>
}
import type { MobileWebTerminalDeviceInputResult } from '../../../src/shared/mobile-web/terminal-stream-contract'
