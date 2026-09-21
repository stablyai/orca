import { DaemonProtocolError } from './daemon-errors'
import { isUnknownRequestTypeError } from './daemon-endpoint-errors'
import { GET_SIZE_PROTOCOL_VERSION } from './daemon-protocol-version'
import { isValidPtySize } from './daemon-pty-size'
import type { ListSessionsResult } from './types'

export type DaemonAppliedPtySize = { cols: number; rows: number }

type DaemonSizeClient = {
  request<T = unknown>(type: string, payload: unknown): Promise<T>
}

type ReadDaemonAppliedPtySizeOptions = {
  client: DaemonSizeClient
  protocolVersion: number
  sessionId: string
  failureMode: 'preserve' | 'suppress'
  getSizeUnsupported: boolean
  markGetSizeUnsupported: () => void
}

/** Reads applied dimensions while preserving an attach caller's transport errors. */
export async function readDaemonAppliedPtySize(
  options: ReadDaemonAppliedPtySizeOptions
): Promise<DaemonAppliedPtySize | null> {
  const {
    client,
    protocolVersion,
    sessionId,
    failureMode,
    getSizeUnsupported,
    markGetSizeUnsupported
  } = options
  const readInventory = async (): Promise<DaemonAppliedPtySize | null> => {
    const { sessions } = await client.request<ListSessionsResult>('listSessions', undefined)
    const session = sessions.find((candidate) => candidate.sessionId === sessionId)
    if (!session || !session.isAlive) {
      return null
    }
    if (!isValidPtySize(session.cols, session.rows)) {
      throw new DaemonProtocolError('Invalid listSessions size response')
    }
    return { cols: session.cols, rows: session.rows }
  }

  const useInventory = protocolVersion < GET_SIZE_PROTOCOL_VERSION || getSizeUnsupported
  if (useInventory) {
    try {
      return await readInventory()
    } catch (error) {
      if (failureMode === 'preserve') {
        throw error
      }
      return null
    }
  }

  try {
    const result = await client.request<{
      size: { cols: number; rows: number } | null
    }>('getSize', { sessionId })
    if (result.size === null) {
      return null
    }
    if (!isValidPtySize(result.size.cols, result.size.rows)) {
      throw new DaemonProtocolError('Invalid getSize response')
    }
    return result.size
  } catch (error) {
    if (isUnknownRequestTypeError(error)) {
      // `getSize` shipped without a protocol bump; cache the negative capability.
      markGetSizeUnsupported()
      try {
        return await readInventory()
      } catch (inventoryError) {
        if (failureMode === 'preserve') {
          throw inventoryError
        }
        return null
      }
    }
    if (failureMode === 'preserve') {
      throw error
    }
    return null
  }
}
