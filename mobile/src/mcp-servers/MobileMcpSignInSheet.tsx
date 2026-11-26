// Sign in to a server from the phone: the bots' paste-back page, run by the host's own sign-in for
// that server. Closing the sheet ends the host's attempt with it.
import { useMemo } from 'react'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { MobileBotToolSignInPage } from '../bots/tools/MobileBotToolSignInPage'
import { usePhoneToolSignIn } from '../bots/tools/use-bot-tool-phone-sign-in'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { mcpServerSignInOps, type PhoneMcpServer } from './mcp-server-operations'
import { mcpServerTitle } from './mcp-server-words'

type Props = {
  client: RpcClient | null
  server: PhoneMcpServer | null
  hostName: string
  online: boolean
  onClose: () => void
  /** Gets the server's title, for the toast. */
  onSignedIn: (title: string) => void
}

export function MobileMcpSignInSheet(props: Props) {
  return (
    <BottomDrawer visible={props.server !== null} onClose={props.onClose}>
      {props.server ? <SignIn {...props} server={props.server} /> : null}
    </BottomDrawer>
  )
}

function SignIn(props: Props & { server: PhoneMcpServer }) {
  const { client, server } = props
  const title = mcpServerTitle(server)
  const owned = useMemo(() => mcpServerSignInOps(server.id), [server.id])
  const signIn = usePhoneToolSignIn({
    client,
    owned,
    held: null,
    hostName: props.hostName,
    onSignedIn: () => props.onSignedIn(title)
  })
  return (
    <MobileBotToolSignInPage
      app={title}
      hostName={props.hostName}
      signIn={signIn}
      disabled={!props.online}
      banner={null}
      onClose={() => {
        signIn.cancel()
        props.onClose()
      }}
    />
  )
}
