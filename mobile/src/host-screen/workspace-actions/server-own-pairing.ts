import { useCallback, useEffect, useRef, useState } from 'react'
import * as z from 'zod'
import { DELEGATED_PHONE_SERVER_OFFER_METHOD } from '../../../../src/shared/remote-runtime/pairing/delegated-phone-server-offer-contract'
import type { Translate } from '../../i18n/mobile-i18n'
import { defineRpcOperation, runRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const offerResultSchema = z.union([
  z.looseObject({ available: z.literal(true), pairingUrl: z.string().min(1) }),
  z.looseObject({ available: z.literal(false), guidance: z.string() })
])

// The server mints it for this phone's relayed row; the desktop stamps the connection mode.
const serverOwnPairingOffer = defineRpcOperation({
  name: 'pairing.delegated-phone-server-offer',
  method: DELEGATED_PHONE_SERVER_OFFER_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('delegated-phone-server-offer', offerResultSchema)
})

export type ServerOwnPairing = { kind: 'pair'; code: string } | { kind: 'refused'; message: string }

/** Asks a server, through the desktop relaying it, for this phone's own pairing with it. */
export async function requestServerOwnPairing(args: {
  serverClient: RpcClient
  serverName: string
  desktopName: string
  t: Translate
}): Promise<ServerOwnPairing> {
  const { t } = args
  try {
    const offer = await runRpcOperation(args.serverClient, serverOwnPairingOffer, {})
    return offer.available
      ? { kind: 'pair', code: offer.pairingUrl }
      : { kind: 'refused', message: offer.guidance }
  } catch (error) {
    console.warn('[server-own-pairing] the server did not answer with a pairing', error)
    // An older desktop relays only the methods it knows and refuses this one itself.
    if (error instanceof Error && error.message.startsWith('forbidden:')) {
      return {
        kind: 'refused',
        message: t(
          'hostScreen.serverOwnPairing.updateDesktop',
          'Update Orca on {{desktop}} to keep {{server}} reachable.',
          { desktop: args.desktopName, server: args.serverName }
        )
      }
    }
    return {
      kind: 'refused',
      message: t(
        'hostScreen.serverOwnPairing.failed',
        'Could not reach {{server}}. Try again while {{desktop}} is awake.',
        { desktop: args.desktopName, server: args.serverName }
      )
    }
  }
}

/** One request per open sheet: the row shows it is working, and a reply that lands after the
 *  sheet closed, moved to another row or left the screen is dropped. */
export function useServerOwnPairingRequest(openRowId: string | null): {
  pending: boolean
  start: (
    args: Parameters<typeof requestServerOwnPairing>[0],
    onAnswer: (answer: ServerOwnPairing) => void
  ) => void
} {
  const [pendingRowId, setPendingRowId] = useState<string | null>(null)
  const openRow = useRef(openRowId)
  useEffect(() => {
    openRow.current = openRowId
    return () => {
      openRow.current = null
    }
  }, [openRowId])
  const start = useCallback(
    (
      args: Parameters<typeof requestServerOwnPairing>[0],
      onAnswer: (answer: ServerOwnPairing) => void
    ) => {
      const rowId = openRow.current
      if (rowId === null) {
        return
      }
      setPendingRowId(rowId)
      void requestServerOwnPairing(args).then((answer) => {
        setPendingRowId((current) => (current === rowId ? null : current))
        if (openRow.current === rowId) {
          onAnswer(answer)
        }
      })
    },
    []
  )
  return { pending: pendingRowId !== null && pendingRowId === openRowId, start }
}
