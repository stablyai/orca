export type PathType = 'direct' | 'relayed' | 'mixed' | 'unknown'

export type IrohStartResult = {
  endpointId: string
}

export type IrohConnectResult = {
  connectionId: string
}

/** Pairing-supplied dial hints: connect on offline LANs and skip discovery RTT. */
export type IrohDialHints = {
  relayUrl?: string | null
  directAddresses?: string[]
}

export type IrohPathInfo = {
  pathType: PathType
  detail: string
}

export type IrohMessageEvent = {
  connectionId: string
  bytesBase64: string
}

export type IrohPathChangedEvent = {
  connectionId: string
  pathType: PathType
  detail: string
}

export type IrohClosedEvent = {
  connectionId: string
  reason: string
}

export type ExpoIrohEventMap = {
  onMessage: IrohMessageEvent
  onPathChanged: IrohPathChangedEvent
  onClosed: IrohClosedEvent
}

export type ExpoIrohNativeModule = {
  irohStart(): Promise<IrohStartResult>
  irohConnect(
    endpointId: string,
    relayUrl?: string | null,
    directAddresses?: string[]
  ): Promise<IrohConnectResult>
  irohSend(connectionId: string, bytesBase64: string): Promise<void>
  irohPathInfo(connectionId: string): Promise<IrohPathInfo>
  irohClose(connectionId: string): Promise<void>
  irohStop(): Promise<void>
  addListener<K extends keyof ExpoIrohEventMap>(
    eventName: K,
    listener: (event: ExpoIrohEventMap[K]) => void
  ): { remove: () => void }
  removeListeners(count: number): void
}
